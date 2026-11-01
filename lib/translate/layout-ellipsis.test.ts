import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLayoutConstraint,
  BASELINE_MARKER_CLASS,
  BASELINE_MARKER_TAG,
  captureLayoutConstraint,
  ELLIPSIS_CLASS,
  ELLIPSIS_TAG,
  installLayoutConstraint,
  layoutConstraintMatchesBaseline,
  layoutProtectedGeometryMatchesBaseline,
  rawTranslationMatchesBaseline,
  rebaselineLayoutConstraint,
  recaptureLayoutConstraint,
  unwrapLayoutConstraint,
} from "./layout-ellipsis";

const rect = (x = 0, y = 0, width = 100, height = 20): DOMRect =>
  ({ x, y, width, height }) as DOMRect;

function stubGeometry(
  node: Text,
  host: Element,
  lines = [rect()],
  textBoundingRect = lines[0] ?? rect(),
  hostRect = rect(),
) {
  vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
    () =>
      ({
        selectNodeContents: () => undefined,
        getBoundingClientRect: () => textBoundingRect,
        getClientRects: () => lines as unknown as DOMRectList,
      }) as unknown as Range,
  );
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(hostRect);
}

function append(tag = "button") {
  const host = document.createElement(tag);
  const node = document.createTextNode("Original text");
  host.append(node);
  document.body.append(host);
  return { host, node };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("captureLayoutConstraint", () => {
  it("does not rebaseline a source-only owner to a fitting shorter translation", () => {
    const { host, node } = append();
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node)!;
    node.data = "Short";
    vi.mocked(host.getBoundingClientRect).mockReturnValue(rect(0, 0, 60, 20));

    expect(rawTranslationMatchesBaseline(constraint)).toBe(false);
    expect(rebaselineLayoutConstraint(constraint)).toBe(false);
    expect(constraint.baselineHostRect.width).toBe(100);
  });

  it("protects an intrinsic owner even when its block has extra dedicated space", () => {
    const item = document.createElement("li");
    const { host, node } = append("a");
    item.style.cssFloat = "left";
    item.style.paddingInlineStart = "0px";
    item.style.paddingInlineEnd = "0px";
    item.style.border = "1px solid transparent";
    host.style.display = "block";
    host.style.paddingInlineStart = "0px";
    host.style.paddingInlineEnd = "0px";
    item.append(host);
    document.body.append(item);
    Object.defineProperty(host, "clientWidth", { value: 100 });
    Object.defineProperty(item, "clientWidth", { value: 100 });
    stubGeometry(
      node,
      host,
      [rect(1, 0, 50, 20)],
      rect(1, 0, 50, 20),
      rect(1, 0, 100, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 102, 20),
    );
    const constraint = captureLayoutConstraint(node)!;
    expect(
      constraint.inlineCandidates.some(
        (candidate) => candidate.capacity === "dedicated",
      ),
    ).toBe(true);
    expect(constraint.preserveInlineFootprint).toBe(true);
    node.data = "Short";
    vi.mocked(host.getBoundingClientRect).mockReturnValue(rect(1, 0, 80, 20));

    expect(rebaselineLayoutConstraint(constraint)).toBe(false);
    expect(constraint.baselineHostRect.width).toBe(100);
  });

  it("retains rebaselining for a dedicated block inside a stretched owner", () => {
    const item = document.createElement("li");
    const { host, node } = append("a");
    host.style.display = "block";
    host.style.paddingInlineStart = "0px";
    host.style.paddingInlineEnd = "0px";
    item.style.paddingInlineStart = "0px";
    item.style.paddingInlineEnd = "0px";
    item.append(host);
    document.body.append(item);
    Object.defineProperty(host, "clientWidth", { value: 100 });
    Object.defineProperty(item, "clientWidth", { value: 100 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 50, 20)],
      rect(0, 0, 50, 20),
      rect(0, 0, 100, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 100, 20),
    );
    const constraint = captureLayoutConstraint(node)!;
    expect(constraint.preserveInlineFootprint).toBe(false);
    node.data = "Translated";
    vi.mocked(host.getBoundingClientRect).mockReturnValue(rect(0, 0, 120, 20));

    expect(rebaselineLayoutConstraint(constraint)).toBe(true);
    expect(constraint.baselineHostRect.width).toBe(120);
  });

  it("does not donate rounded content capacity from an intrinsic parent of a stretched block", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("What's New");
    item.style.cssFloat = "left";
    item.style.padding = "0px";
    item.style.paddingInlineStart = "0px";
    item.style.paddingInlineEnd = "0px";
    item.style.border = "1px solid transparent";
    host.style.display = "block";
    host.style.padding = "0px 11px";
    host.style.paddingInlineStart = "11px";
    host.style.paddingInlineEnd = "11px";
    host.append(node);
    item.append(host);
    list.append(item);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 89 });
    Object.defineProperty(item, "clientWidth", { value: 89 });
    stubGeometry(
      node,
      host,
      [rect(12, 0, 66.90625, 14)],
      rect(12, 0, 66.90625, 14),
      rect(1, 0, 88.90625, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 90.90625, 20),
    );

    expect(captureLayoutConstraint(node)?.inlineCandidates).toMatchObject([
      { inlineSize: 66.90625, capacity: "source" },
    ]);
    expect(captureLayoutConstraint(node)?.inlineCandidates).toHaveLength(1);
  });

  it("captures a native control as a single-line bounded surface", () => {
    const { host, node } = append();
    stubGeometry(node, host);
    Object.defineProperty(host, "clientWidth", { value: 200 });

    expect(captureLayoutConstraint(node)).toMatchObject({
      node,
      host,
      mode: "single-line",
      inlineSize: 100,
      blockSize: 20,
      lineCount: 1,
      wrapper: null,
    });
  });

  it("preserves a block link's calculated single-line box", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#nav");
    host.style.display = "block";
    host.style.lineHeight = "26.4px";
    stubGeometry(
      node,
      host,
      [rect(0, 0, 100, 14)],
      rect(0, 0, 100, 14),
      rect(0, 0, 100, 26.4),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      blockSize: 26.4,
    });
  });

  it("uses a non-control host's current content-box capacity", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#nav");
    host.style.display = "block";
    host.style.paddingInlineStart = "10px";
    host.style.paddingInlineEnd = "15px";
    Object.defineProperty(host, "clientWidth", { value: 150 });
    stubGeometry(
      node,
      host,
      [rect(10, 0, 100, 14)],
      rect(10, 0, 100, 14),
      rect(0, 0, 150, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      inlineSize: 125,
    });
  });

  it("collects a larger stable list-item content box after glyph width", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 123, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 123,
      inlineCandidates: [{ inlineSize: 59 }, { inlineSize: 123 }],
    });
  });

  it("keeps inline sibling anchors under a navigation host source-only", () => {
    const nav = document.createElement("nav");
    const host = document.createElement("a");
    const peer = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    peer.href = "#peer";
    host.append(node);
    nav.append(host, peer);
    document.body.append(nav);
    Object.defineProperty(nav, "clientWidth", { value: 240 });
    stubGeometry(
      node,
      nav,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 240, 20),
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 59, 20));
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(59, 0, 80, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      host: nav,
      inlineSize: 59,
      inlineCandidates: [{ inlineSize: 59 }],
    });
  });

  it("accounts for an icon nested beside the text owner", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const host = document.createElement("a");
    const label = document.createElement("span");
    const icon = document.createElement("span");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    label.append(node);
    host.append(label, icon);
    item.append(host);
    list.append(item);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 123 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 123, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(
      rect(100, 0, 23, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 100,
      inlineCandidates: [
        { inlineSize: 59 },
        { inlineSize: 100, siblings: [{ element: icon }] },
      ],
    });
  });

  it("rejects larger capacity when the owner has another visible Text node", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#menu");
    host.style.display = "block";
    host.append(document.createTextNode(" Badge"));
    Object.defineProperty(host, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 123, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 59,
      inlineCandidates: [{ inlineSize: 59 }],
    });
  });

  it("skips an invisible ancestor content-box candidate", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0, 20));
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 123, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 59,
      inlineCandidates: [{ inlineSize: 59 }],
    });
  });

  it("reserves preceding flex-icon capacity instead of the full row", () => {
    const nav = document.createElement("nav");
    const row = document.createElement("div");
    const icon = document.createElement("span");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    row.style.display = "flex";
    row.style.flexDirection = "row";
    row.style.flexWrap = "nowrap";
    row.style.direction = "ltr";
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    row.append(icon, host);
    nav.append(row);
    document.body.append(nav);
    Object.defineProperty(row, "clientWidth", { value: 168 });
    Object.defineProperty(host, "clientWidth", { value: 148 });
    stubGeometry(
      node,
      host,
      [rect(35, 0, 59, 14)],
      rect(35, 0, 59, 14),
      rect(20, 0, 148, 20),
    );
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(0, 0, 168, 20));
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(rect(0, 0, 20, 20));

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 133,
      inlineCandidates: [{ inlineSize: 59 }, { inlineSize: 133 }],
    });
  });

  it("caps flex text capacity at a following in-flow sibling", () => {
    const nav = document.createElement("nav");
    const row = document.createElement("div");
    const host = document.createElement("a");
    const trailing = document.createElement("span");
    const node = document.createTextNode("Menu label");
    row.style.display = "flex";
    row.style.flexDirection = "row";
    row.style.flexWrap = "nowrap";
    row.style.direction = "ltr";
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    row.append(host, trailing);
    nav.append(row);
    document.body.append(nav);
    Object.defineProperty(row, "clientWidth", { value: 168 });
    Object.defineProperty(host, "clientWidth", { value: 168 });
    stubGeometry(
      node,
      host,
      [rect(20, 0, 59, 14)],
      rect(20, 0, 59, 14),
      rect(0, 0, 168, 20),
    );
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(0, 0, 168, 20));
    vi.spyOn(trailing, "getBoundingClientRect").mockReturnValue(
      rect(100, 0, 20, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 80,
      inlineCandidates: [{ inlineSize: 59 }, { inlineSize: 80 }],
    });
  });

  it("excludes padding, icons, and visible in-flow siblings from item capacity", () => {
    const host = document.createElement("a");
    const leadingIcon = document.createElement("span");
    const trailingBadge = document.createElement("span");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.style.paddingInline = "10px 15px";
    host.append(leadingIcon, node, trailingBadge);
    document.body.append(host);
    Object.defineProperty(host, "clientWidth", { value: 150 });
    stubGeometry(
      node,
      host,
      [rect(35, 0, 59, 14)],
      rect(35, 0, 59, 14),
      rect(0, 0, 150, 20),
    );
    vi.spyOn(leadingIcon, "getBoundingClientRect").mockReturnValue(
      rect(10, 0, 20, 20),
    );
    vi.spyOn(trailingBadge, "getBoundingClientRect").mockReturnValue(
      rect(100, 0, 20, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 65,
      inlineCandidates: [
        { inlineSize: 59, capacity: "source" },
        { inlineSize: 65, capacity: "dedicated" },
      ],
    });
  });

  it("does not borrow capacity from a shared flex row", () => {
    const nav = document.createElement("nav");
    const row = document.createElement("div");
    const host = document.createElement("a");
    const peer = document.createElement("a");
    const node = document.createTextNode("Menu label");
    row.style.display = "flex";
    row.style.flexWrap = "nowrap";
    host.href = "#menu";
    peer.href = "#peer";
    host.style.display = "block";
    host.append(node);
    row.append(host, peer);
    nav.append(row);
    document.body.append(nav);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(row, "clientWidth", { value: 300 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 20));
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(200, 0, 59, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 59,
      inlineCandidates: [{ inlineSize: 59, capacity: "source" }],
    });
  });

  it("keeps ambiguous wrapping flex layouts on the conservative candidate", () => {
    const nav = document.createElement("nav");
    const row = document.createElement("div");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    row.style.display = "flex";
    row.style.flexDirection = "row";
    row.style.flexWrap = "wrap";
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    row.append(host);
    nav.append(row);
    document.body.append(nav);
    Object.defineProperty(row, "clientWidth", { value: 168 });
    Object.defineProperty(host, "clientWidth", { value: 59 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(0, 0, 168, 20));

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 59,
      inlineCandidates: [{ inlineSize: 59 }],
    });
  });

  it("selects remaining dedicated capacity for a stretched icon+text control", () => {
    const host = document.createElement("button");
    const icon = document.createElement("span");
    const node = document.createTextNode("請求書");
    host.style.display = "flex";
    host.style.flexDirection = "row";
    host.style.flexWrap = "nowrap";
    host.style.padding = "0px";
    host.style.border = "0px";
    host.append(icon, node);
    document.body.append(host);
    Object.defineProperty(host, "clientWidth", { value: 280 });
    stubGeometry(
      node,
      host,
      [rect(32, 0, 40, 14)],
      rect(32, 0, 40, 14),
      rect(0, 0, 280, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 20));

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 248,
      inlineCandidates: [
        { inlineSize: 40, capacity: "source" },
        { inlineSize: 248, capacity: "dedicated" },
      ],
    });
  });

  it("keeps a padded shrink-to-fit button on source capacity", () => {
    const { host, node } = append();
    host.style.paddingInlineStart = "12px";
    host.style.paddingInlineEnd = "12px";
    Object.defineProperty(host, "clientWidth", { value: 64 });
    stubGeometry(
      node,
      host,
      [rect(12, 0, 40, 14)],
      rect(12, 0, 40, 14),
      rect(0, 0, 64, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 40,
      inlineCandidates: [{ inlineSize: 40, capacity: "source" }],
    });
  });

  it("keeps a shrink-to-fit action button in a shared nav source-only", () => {
    const nav = document.createElement("nav");
    const host = document.createElement("button");
    const peer = document.createElement("a");
    const node = document.createTextNode("メニュー");
    peer.href = "#peer";
    host.append(node);
    nav.append(host, peer);
    document.body.append(nav);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(nav, "clientWidth", { value: 240 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(0, 0, 240, 20));
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(80, 0, 80, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      host,
      inlineSize: 59,
      inlineCandidates: [{ inlineSize: 59, capacity: "source" }],
    });
  });

  it("skips an unmeasurable generated-content ancestor without aborting the walk", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 80 });
    Object.defineProperty(item, "clientWidth", { value: 200 });
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        element === host && pseudo === "::after"
          ? ({
              content: '"→"',
              display: "inline",
              float: "none",
              position: "static",
              visibility: "visible",
            } as CSSStyleDeclaration)
          : nativeGetComputedStyle(element, pseudo),
    );
    stubGeometry(
      node,
      host,
      [rect(0, 0, 50, 14)],
      rect(0, 0, 50, 14),
      rect(0, 0, 80, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 200, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 200, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 200,
      inlineCandidates: [
        { inlineSize: 50, capacity: "source" },
        { inlineSize: 200, capacity: "dedicated" },
      ],
    });
  });

  it("subtracts measurable in-flow generated content from remaining capacity", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#menu");
    host.style.display = "block";
    Object.defineProperty(host, "clientWidth", { value: 150 });
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        element === host && pseudo === "::after"
          ? ({
              content: '"→"',
              display: "inline",
              float: "none",
              cssFloat: "none",
              position: "static",
              visibility: "visible",
              width: "24px",
              marginInlineStart: "0px",
              marginInlineEnd: "0px",
            } as CSSStyleDeclaration)
          : nativeGetComputedStyle(element, pseudo),
    );
    stubGeometry(
      node,
      host,
      [rect(0, 0, 50, 14)],
      rect(0, 0, 50, 14),
      rect(0, 0, 150, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      inlineSize: 126,
      inlineCandidates: [
        { inlineSize: 50, capacity: "source" },
        { inlineSize: 126, capacity: "dedicated" },
      ],
    });
  });

  it("falls back to glyph width when the host content box is unmeasurable", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#nav");
    host.style.display = "block";
    Object.defineProperty(host, "clientWidth", { value: Number.NaN });
    stubGeometry(node, host);

    expect(captureLayoutConstraint(node)).toMatchObject({ inlineSize: 100 });
  });

  it("retains glyph-height sizing for native controls with numeric line-height", () => {
    const { host, node } = append();
    host.style.lineHeight = "20px";
    stubGeometry(
      node,
      host,
      [rect(0, 0, 100, 14)],
      rect(0, 0, 100, 14),
      rect(0, 0, 100, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      blockSize: 14,
    });
  });

  it("retains glyph-height fallback for a nonnumeric single-line line-height", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#nav");
    host.style.display = "block";
    host.style.lineHeight = "normal";
    stubGeometry(
      node,
      host,
      [rect(0, 0, 100, 14)],
      rect(0, 0, 100, 14),
      rect(0, 0, 100, 26.4),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      blockSize: 14,
    });
  });

  it("clusters noisy Range fragments while keeping true extra lines", () => {
    const menu = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Around Asia");
    host.append(node);
    item.append(host);
    menu.append(item, peer);
    document.body.append(menu);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 30, 100, 30),
    );
    stubGeometry(
      node,
      item,
      [rect(0, 0, 40, 14), rect(40, 1, 40, 14), rect(0, 16, 80, 14)],
      rect(0, 0, 80, 30),
      rect(0, 0, 100, 30),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "multi-line",
      lineCount: 2,
    });
  });

  it("captures a repeated list item as a multi-line bounded surface", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const node = document.createTextNode("Card teaser");
    item.append(node);
    item.style.lineHeight = "20px";
    list.append(item, peer);
    document.body.append(list);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(rect());
    stubGeometry(
      node,
      item,
      [rect(0, 0, 100, 20), rect(0, 20, 90, 20)],
      rect(0, 0, 100, 37),
      rect(0, 0, 220, 40),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      host: item,
      mode: "multi-line",
      inlineSize: 220,
      blockSize: 40,
      lineCount: 2,
    });
  });

  it("captures a block-level interactive card without repeated peers", () => {
    const link = document.createElement("a");
    const heading = document.createElement("h2");
    const node = document.createTextNode("Card teaser");
    link.href = "#card";
    link.style.display = "block";
    heading.style.lineHeight = "20px";
    heading.append(node);
    link.append(heading);
    document.body.append(link);
    stubGeometry(
      node,
      heading,
      [rect(0, 0, 100, 20), rect(0, 20, 90, 20)],
      rect(0, 0, 100, 37),
      rect(0, 0, 220, 40),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      host: heading,
      mode: "multi-line",
      inlineSize: 220,
    });
  });

  it("preserves a sole inline paragraph link's single-line footprint", () => {
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    const node = document.createTextNode("Inline link");
    link.append(node);
    paragraph.append(link);
    document.body.append(paragraph);
    stubGeometry(node, paragraph);

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      lineCount: 1,
    });
  });

  it("keeps a paragraph with mixed inline text as readable flow", () => {
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    const linkText = document.createTextNode("Inline link");
    const node = document.createTextNode("Sentence start ");
    link.append(linkText);
    paragraph.append(node, link);
    document.body.append(paragraph);
    stubGeometry(node, paragraph);

    expect(captureLayoutConstraint(node)).toBeNull();
  });

  it("preserves sole-text article content but not editable or vertical text", () => {
    const paragraph = document.createElement("p");
    const node = document.createTextNode("Article body");
    paragraph.append(node);
    document.body.append(paragraph);
    stubGeometry(node, paragraph);
    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      lineCount: 1,
    });

    Object.defineProperty(paragraph, "isContentEditable", {
      configurable: true,
      value: true,
    });
    expect(captureLayoutConstraint(node)).toBeNull();
    Object.defineProperty(paragraph, "isContentEditable", {
      configurable: true,
      value: false,
    });
    paragraph.style.writingMode = "vertical-rl";
    expect(captureLayoutConstraint(node)).toBeNull();
  });

  it("clamps a sole-text flex/grid article paragraph to its line count", () => {
    const article = document.createElement("article");
    const columns = document.createElement("div");
    const body = document.createElement("p");
    const peer = document.createElement("p");
    const node = document.createTextNode("Article body");
    columns.style.display = "flex";
    body.append(node);
    peer.textContent = "Sidebar copy";
    columns.append(body, peer);
    article.append(columns);
    document.body.append(article);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(rect());
    stubGeometry(node, body, [rect(0, 0, 100, 20), rect(0, 20, 90, 20)]);
    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "multi-line",
      lineCount: 2,
    });

    columns.style.display = "grid";
    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "multi-line",
      lineCount: 2,
    });
  });

  it("uses the same horizontal logical policy for RTL text", () => {
    const { host, node } = append();
    host.dir = "rtl";
    stubGeometry(node, host);

    expect(captureLayoutConstraint(node)?.mode).toBe("single-line");
  });
});

describe("layout constraint wrapper", () => {
  it("rejects a line-count change even without protected rectangles", () => {
    const { host, node } = append();
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getClientRects: () =>
            [rect(0, 0, 50, 20), rect(0, 20, 50, 20)] as unknown as DOMRectList,
        }) as unknown as Range,
    );

    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(false);
  });

  it("does not discover capacity beyond a clipped overflow ancestor", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const clipped = document.createElement("div");
    const host = document.createElement("a");
    const peer = document.createElement("li");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    clipped.style.overflowX = "hidden";
    host.append(node);
    clipped.append(host);
    item.append(clipped);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(clipped, "clientWidth", { value: 61 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(node, host, [rect(0, 0, 59, 14)], rect(0, 0, 59, 14));
    vi.spyOn(clipped, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 61, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 123, 20),
    );

    expect(captureLayoutConstraint(node)?.inlineCandidates).toMatchObject([
      { inlineSize: 59, capacity: "source" },
      { inlineSize: 61, capacity: "dedicated" },
    ]);
  });

  it("keeps a smaller direct flex-item capacity for an overflowing source", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const cell = document.createElement("div");
    const icon = document.createElement("span");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    cell.style.display = "flex";
    host.append(node);
    cell.append(icon, host);
    item.append(cell);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 100 });
    Object.defineProperty(cell, "clientWidth", { value: 120 });
    Object.defineProperty(item, "clientWidth", { value: 120 });
    stubGeometry(
      node,
      host,
      [rect(20, 0, 120, 14)],
      rect(20, 0, 120, 14),
      rect(20, 0, 100, 20),
    );
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 120, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(rect(0, 0, 20, 20));
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 120, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 120, 20),
    );

    expect(captureLayoutConstraint(node)?.inlineCandidates).toMatchObject([
      { inlineSize: 120, capacity: "source" },
      { inlineSize: 100, capacity: "dedicated" },
    ]);
  });

  it("reserves flex gaps around visible siblings", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const leadingIcon = document.createElement("span");
    const trailingIcon = document.createElement("span");
    const node = document.createTextNode("Menu");
    host.href = "#menu";
    host.style.display = "flex";
    host.style.columnGap = "12px";
    host.append(leadingIcon, node, trailingIcon);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 140 });
    Object.defineProperty(item, "clientWidth", { value: 140 });
    stubGeometry(node, host, [rect(32, 0, 130, 14)], rect(32, 0, 130, 14));
    vi.spyOn(leadingIcon, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 20, 20),
    );
    vi.spyOn(trailingIcon, "getBoundingClientRect").mockReturnValue(
      rect(120, 0, 20, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 140, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 140, 20),
    );

    expect(captureLayoutConstraint(node)?.inlineCandidates).toMatchObject([
      { inlineSize: 130, capacity: "source" },
      { inlineSize: 76, capacity: "dedicated" },
    ]);
  });

  it("preserves Text identity and writes only extension-owned contract properties", () => {
    const { host, node } = append();
    host.title = "Host title";
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(installLayoutConstraint(constraint)).toBe(true);
    const wrapper = constraint.wrapper;
    expect(wrapper?.tagName).toBe(ELLIPSIS_TAG.toUpperCase());
    expect(wrapper).toBeInstanceOf(HTMLElement);
    expect(wrapper?.classList.contains(ELLIPSIS_CLASS)).toBe(true);
    expect(wrapper?.dataset.tryhandLayout).toBe("single-line");
    expect(wrapper?.style.verticalAlign).toBe("0px");
    expect(wrapper?.style.padding).toBe("0px");
    expect(wrapper?.style.getPropertyValue("--tryhand-inline-size")).toBe(
      "100px",
    );
    expect(wrapper?.style.getPropertyValue("--tryhand-block-size")).toBe(
      "20px",
    );
    expect(wrapper?.style.getPropertyValue("--tryhand-lines")).toBe("1");
    expect(wrapper?.firstChild).toBe(node);
    expect(host.getAttribute("style")).toBeNull();
    expect(host.title).toBe("Host title");
  });

  it("starts a non-control single-line wrapper with a numeric correction", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#nav");
    host.style.display = "block";
    host.style.lineHeight = "26.4px";
    stubGeometry(
      node,
      host,
      [rect(0, 0, 100, 14)],
      rect(0, 0, 100, 14),
      rect(0, 0, 100, 26.4),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);

    expect(constraint?.wrapper?.style.verticalAlign).toBe("0px");
  });

  it("commits wider fitting text raw inside a stable cell", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(0, 0, node.data === "Translated label" ? 100 : 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 123, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(applyLayoutConstraint(constraint, "Translated label")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(node.data).toBe("Translated label");
    expect(node.parentElement).toBe(host);
    expect(host.querySelector(ELLIPSIS_TAG)).toBeNull();
    expect(host.title).toBe("");
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);

    node.data = constraint.originalText;
    vi.spyOn(window, "scrollY", "get").mockReturnValue(640);
    const secondConstraint = captureLayoutConstraint(node);
    expect(secondConstraint).not.toBeNull();
    if (!secondConstraint) return;
    expect(applyLayoutConstraint(secondConstraint, "Translated label")).toEqual(
      { outcome: "translated-raw", wrapper: null },
    );
    expect(node.parentElement).toBe(host);
    expect(layoutProtectedGeometryMatchesBaseline(secondConstraint)).toBe(true);
  });

  it("keeps bounded multi-line text raw when it re-fragments inside the captured footprint", () => {
    const list = document.createElement("ul");
    const host = document.createElement("li");
    const peer = document.createElement("li");
    const node = document.createTextNode("Card teaser");
    host.append(node);
    host.style.lineHeight = "20px";
    list.append(host, peer);
    document.body.append(list);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(rect());
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            node.data === "Translated card"
              ? rect(0, 0, 180, 38)
              : rect(0, 0, 100, 37),
          getClientRects: () =>
            (node.data === "Translated card"
              ? [rect(0, 0, 180, 20), rect(0, 20, 30, 20)]
              : [
                  rect(0, 0, 100, 20),
                  rect(0, 20, 90, 20),
                ]) as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 220, 40),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(applyLayoutConstraint(constraint, "Translated card")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(node.data).toBe("Translated card");
    expect(node.parentElement).toBe(host);
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
  });

  it("clamps true bounded multi-line overflow with the exact translated title", () => {
    const list = document.createElement("ul");
    const host = document.createElement("li");
    const peer = document.createElement("li");
    const node = document.createTextNode("Card teaser");
    host.append(node);
    host.style.lineHeight = "20px";
    list.append(host, peer);
    document.body.append(list);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(rect());
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            node.data === "Long translated card"
              ? rect(0, 0, 180, 60)
              : rect(0, 0, 100, 37),
          getClientRects: () =>
            (node.data === "Long translated card"
              ? [rect(0, 0, 180, 20), rect(0, 20, 170, 20), rect(0, 40, 80, 20)]
              : [
                  rect(0, 0, 100, 20),
                  rect(0, 20, 90, 20),
                ]) as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(
        0,
        0,
        220,
        node.data === "Long translated card" &&
          !host.querySelector(ELLIPSIS_TAG)
          ? 60
          : 40,
      ),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, "Long translated card");

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.firstChild).toBe(node);
    expect(result.wrapper?.title).toBe("Long translated card");
    expect(result.wrapper?.dataset.tryhandLayout).toBe("multi-line");
    expect(result.wrapper?.style.getPropertyValue("--tryhand-lines")).toBe("2");
    expect(result.wrapper?.style.getPropertyValue("--tryhand-block-size")).toBe(
      "40px",
    );
  });

  it("clamps an intrinsically overflowing unbreakable multi-line translation", () => {
    const list = document.createElement("ul");
    const host = document.createElement("li");
    const peer = document.createElement("li");
    const node = document.createTextNode("Bounded card title");
    const translated = "MotBanDichRatDaiKhongTheNgatDong";
    host.append(node);
    host.style.lineHeight = "20px";
    list.append(host, peer);
    document.body.append(list);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(rect());
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            node.data === translated
              ? rect(0, 0, 350, 20)
              : rect(0, 0, 200, 40),
          getClientRects: () =>
            (node.data === translated
              ? [rect(0, 0, 350, 20)]
              : [
                  rect(0, 0, 200, 20),
                  rect(0, 20, 120, 20),
                ]) as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 220, 40),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint?.mode).toBe("multi-line");
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, translated);

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.title).toBe(translated);
    expect(result.wrapper?.firstChild).toBe(node);
    expect(node.data).toBe(translated);
  });

  it("accepts a dedicated wrapper when clipping changes only source Range width", () => {
    const nav = document.createElement("nav");
    const host = document.createElement("a");
    const node = document.createTextNode("Overwide source label");
    const translated = "Much longer translated navigation label";
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    nav.append(host);
    document.body.append(nav);
    Object.defineProperty(host, "clientWidth", { value: 104 });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(38, 0, 104, 20),
    );
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(() => {
      const width =
        node.data === translated
          ? 250
          : node.parentElement?.localName === ELLIPSIS_TAG
            ? 104
            : 130;
      return {
        selectNodeContents: () => undefined,
        getBoundingClientRect: () => rect(38, 0, width, 14),
        getClientRects: () =>
          [rect(38, 0, width, 14)] as unknown as DOMRectList,
      } as unknown as Range;
    });
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.localName === ELLIPSIS_TAG) return rect(38, 0, 104, 20);
        if (this.localName === BASELINE_MARKER_TAG) return rect(38, 14, 0, 0);
        return nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint?.inlineCandidates).toMatchObject([
      { inlineSize: 130, capacity: "source" },
      { inlineSize: 104, capacity: "dedicated" },
    ]);
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, translated);

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.title).toBe(translated);
    expect(
      result.wrapper?.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("104px");
  });

  it("clamps a multi-line article heading reached through an inline link", () => {
    const article = document.createElement("article");
    const link = document.createElement("a");
    const host = document.createElement("h2");
    const node = document.createTextNode("Unbreakable multi source");
    const translated = "ChuoiDichKhongTheNgatRatDaiPhaiBiGioiHan";
    link.href = "#card";
    host.style.lineHeight = "20px";
    host.append(node);
    link.append(host);
    article.append(link);
    document.body.append(article);
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            node.data === translated
              ? rect(0, 0, 350, 20)
              : rect(0, 0, 140, 40),
          getClientRects: () =>
            (node.data === translated
              ? [rect(0, 0, 350, 20)]
              : [
                  rect(0, 0, 140, 20),
                  rect(0, 20, 80, 20),
                ]) as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 150, 40),
    );
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.localName === ELLIPSIS_TAG
          ? rect(0, 0, 150, 40)
          : nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint?.mode).toBe("multi-line");
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, translated);

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.title).toBe(translated);
    expect(result.wrapper?.dataset.tryhandLayout).toBe("multi-line");
  });

  it("recaptures changed ownership geometry and restores cached translation", () => {
    const nav = document.createElement("nav");
    const host = document.createElement("a");
    const newHost = document.createElement("a");
    const node = document.createTextNode("Menu");
    const translated = "Translated menu label";
    host.href = "#menu";
    host.style.display = "block";
    newHost.href = "#new-menu";
    newHost.style.display = "block";
    host.append(node);
    nav.append(host, newHost);
    document.body.append(nav);
    Object.defineProperty(host, "clientWidth", { value: 80 });
    Object.defineProperty(newHost, "clientWidth", { value: 160 });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 80, 20));
    vi.spyOn(newHost, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 160, 20),
    );
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(
              0,
              newHost.contains(node) ? 20 : 0,
              node.data === translated ? 130 : 40,
              14,
            ),
          getClientRects: () =>
            [
              rect(
                0,
                newHost.contains(node) ? 20 : 0,
                node.data === translated ? 130 : 40,
                14,
              ),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.localName === ELLIPSIS_TAG
          ? rect(0, 0, 80, 20)
          : nativeRect.call(this);
      },
    );
    const first = captureLayoutConstraint(node);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(applyLayoutConstraint(first, translated)).toMatchObject({
      outcome: "translated-constrained",
    });

    expect(first.wrapper).not.toBeNull();
    if (!first.wrapper) return;
    newHost.append(first.wrapper);
    const recaptured = recaptureLayoutConstraint(first, translated);

    expect(recaptured).not.toBeNull();
    expect(node.data).toBe(translated);
    expect(node.parentElement).toBe(newHost);
    expect(recaptured?.host).toBe(newHost);
    expect(recaptured?.inlineSize).toBe(160);
    if (!recaptured) return;
    expect(applyLayoutConstraint(recaptured, translated)).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
  });

  it("does not freeze an ordinary stable cell across restore and reflow", () => {
    const nav = document.createElement("nav");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    nav.append(host);
    document.body.append(nav);
    let hostWidth = 123;
    Object.defineProperty(host, "clientWidth", { value: 123 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(0, 0, hostWidth, 20),
    );
    const first = captureLayoutConstraint(node);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(applyLayoutConstraint(first, "Translated label")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });

    hostWidth = 126;
    expect(layoutProtectedGeometryMatchesBaseline(first)).toBe(true);
    node.data = first.originalText;
    const second = captureLayoutConstraint(node);
    expect(second).not.toBeNull();
    if (!second) return;
    expect(applyLayoutConstraint(second, "Translated label")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(node.parentElement).toBe(host);
    expect(layoutProtectedGeometryMatchesBaseline(second)).toBe(true);
  });

  it("keeps fitting constrained text full and without a title", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
          getClientRects: () =>
            (node.data === "Translated label" &&
            !host.querySelector(ELLIPSIS_TAG)
              ? [rect(0, 0, 55, 14), rect(0, 14, 45, 14)]
              : [
                  rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
                ]) as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(0, 0, host.querySelector(ELLIPSIS_TAG) ? 123 : 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.localName === ELLIPSIS_TAG
          ? rect(0, 0, 123, 20)
          : nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, "Translated label");

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.textContent).toBe("Translated label");
    expect(result.wrapper?.title).toBe("");
    expect(
      result.wrapper?.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("123px");
  });

  it("rolls raw text back before using an overflowing wrapper to hold an inline icon", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Original text");
    const icon = document.createElement("span");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node, icon);
    item.append(host);
    list.append(item);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 60 });
    Object.defineProperty(item, "clientWidth", { value: 120 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Full translation" ? 100 : 60, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Full translation" ? 100 : 60, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(
        0,
        0,
        node.data === "Full translation" && !host.querySelector(ELLIPSIS_TAG)
          ? 100
          : 60,
        20,
      ),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 120, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() => {
      const wrapper = host.querySelector<HTMLElement>(ELLIPSIS_TAG);
      if (wrapper)
        return rect(
          Number.parseFloat(
            wrapper.style.getPropertyValue("--tryhand-inline-size"),
          ),
          0,
          10,
          10,
        );
      return rect(node.data === "Full translation" ? 100 : 60, 0, 10, 10);
    });
    const insertedText: string[] = [];
    const insertBefore = host.insertBefore.bind(host);
    vi.spyOn(host, "insertBefore").mockImplementation((newNode, reference) => {
      if ((newNode as Element).localName === ELLIPSIS_TAG)
        insertedText.push(node.data);
      return insertBefore(newNode, reference);
    });
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    expect(constraint.inlineCandidates).toMatchObject([
      { inlineSize: 60, capacity: "source" },
    ]);

    const { wrapper } = applyLayoutConstraint(constraint, "Full translation");

    expect(insertedText).toEqual(["Original text"]);
    expect(wrapper?.firstChild).toBe(node);
    expect(wrapper?.title).toBe("Full translation");
    expect(icon.getAttribute("style")).toBeNull();
  });

  it("uses a wrapper when in-flow generated content depends on the text footprint", () => {
    const { host, node } = append("a");
    (host as HTMLAnchorElement).href = "#menu";
    host.style.display = "block";
    Object.defineProperty(host, "clientWidth", { value: 120 });
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        element === host && pseudo === "::after"
          ? ({
              content: '"→"',
              display: "inline",
              float: "none",
              position: "static",
              visibility: "visible",
            } as CSSStyleDeclaration)
          : nativeGetComputedStyle(element, pseudo),
    );
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Translated label" ? 100 : 60, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Translated label" ? 100 : 60, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 120, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    const { wrapper } = applyLayoutConstraint(constraint, "Translated label");

    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.getPropertyValue("--tryhand-inline-size")).toBe(
      "60px",
    );
    expect(wrapper?.title).toBe("Translated label");
    expect(host.className).toBe("");
    expect(host.getAttribute("style")).toBe("display: block;");
  });

  it("allows a background icon to move with its text parent", () => {
    const link = document.createElement("a");
    const host = document.createElement("span");
    const node = document.createTextNode("HOME");
    link.href = "#home";
    host.style.display = "inline-block";
    host.style.whiteSpace = "nowrap";
    host.style.backgroundImage = 'url("home.svg")';
    host.append(node);
    link.append(host);
    document.body.append(link);
    Object.defineProperty(host, "clientWidth", { value: 54 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(
              node.data === "TRANG CHỦ" && !host.querySelector(ELLIPSIS_TAG)
                ? 7.5
                : 0,
              0,
              54,
              14,
            ),
          getClientRects: () => [rect(0, 0, 54, 14)] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(
        node.data === "TRANG CHỦ" && !host.querySelector(ELLIPSIS_TAG)
          ? 7.5
          : 0,
        0,
        54,
        14,
      ),
    );
    const originalStyle = host.getAttribute("style");
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, "TRANG CHỦ");

    expect(result).toEqual({ outcome: "translated-raw", wrapper: null });
    expect(node.parentElement).toBe(host);
    expect(host.getBoundingClientRect().x).toBe(7.5);
    expect(host.getAttribute("style")).toBe(originalStyle);
  });

  it("allows a reference and background owner to move together", () => {
    const link = document.createElement("a");
    const host = document.createElement("span");
    const node = document.createTextNode("HOME");
    link.href = "#home";
    host.style.display = "inline-block";
    host.style.whiteSpace = "nowrap";
    host.style.backgroundImage = 'url("home.svg")';
    host.append(node);
    link.append(host);
    document.body.append(link);
    let hostX = 0;
    Object.defineProperty(host, "clientWidth", { value: 54 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 54, 14)],
      rect(0, 0, 54, 14),
      rect(0, 0, 54, 14),
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(hostX, 0, 54, 14),
    );
    const originalStyle = host.getAttribute("style");
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    expect(applyLayoutConstraint(constraint, "HOME")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });

    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
    hostX = 7.5;
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
    expect(host.getAttribute("style")).toBe(originalStyle);
  });

  it("detects a background owner moving relative to its reference host", () => {
    const host = document.createElement("a");
    const owner = document.createElement("span");
    const node = document.createTextNode("HOME");
    host.href = "#home";
    host.style.display = "block";
    owner.style.backgroundImage = 'url("home.svg")';
    owner.append(node);
    host.append(owner);
    document.body.append(host);
    let ownerX = 0;
    Object.defineProperty(host, "clientWidth", { value: 100 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 54, 14)],
      rect(0, 0, 54, 14),
      rect(0, 0, 100, 20),
    );
    vi.spyOn(owner, "getBoundingClientRect").mockImplementation(() =>
      rect(ownerX, 0, 54, 14),
    );
    const originalStyle = owner.getAttribute("style");
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    expect(applyLayoutConstraint(constraint, "HOME")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });

    ownerX = 7.5;

    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(false);
    expect(owner.getAttribute("style")).toBe(originalStyle);
  });

  it("allows a stable owner and SVG sibling to move together", () => {
    const host = document.createElement("a");
    const node = document.createTextNode("HOME");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.href = "#home";
    host.style.display = "block";
    host.append(node, icon);
    document.body.append(host);
    let ownerY = 100;
    Object.defineProperty(host, "clientWidth", { value: 54 });
    stubGeometry(
      node,
      host,
      [rect(0, 100, 54, 14)],
      rect(0, 100, 54, 14),
      rect(0, 100, 54, 20),
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(0, ownerY, 54, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() =>
      rect(0, ownerY, 14, 14),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    expect(applyLayoutConstraint(constraint, "HOME")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });

    ownerY = 360;

    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
    expect(icon.getAttribute("style")).toBeNull();
  });

  it("retries a later translation when it shifts an earlier SVG sibling", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);

    const homeHost = document.createElement("a");
    const homeNode = document.createTextNode("HOME");
    const homeIcon = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    homeHost.href = "#home";
    homeHost.style.display = "block";
    homeHost.append(homeNode, homeIcon);
    document.body.append(homeHost);
    Object.defineProperty(homeHost, "clientWidth", { value: 54 });
    stubGeometry(
      homeNode,
      homeHost,
      [rect(0, 0, 54, 14)],
      rect(0, 0, 54, 14),
      rect(0, 0, 54, 20),
    );
    vi.spyOn(homeIcon, "getBoundingClientRect").mockImplementation(() =>
      rect(
        node.data === "Translated label" && !host.querySelector(ELLIPSIS_TAG)
          ? 7.5
          : 0,
        0,
        14,
        14,
      ),
    );
    const homeConstraint = captureLayoutConstraint(homeNode);
    expect(homeConstraint).not.toBeNull();
    if (!homeConstraint) return;
    expect(applyLayoutConstraint(homeConstraint, "HOME")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(layoutProtectedGeometryMatchesBaseline(homeConstraint)).toBe(true);

    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Translated label" ? 100 : 59, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(
        0,
        0,
        host.querySelector(ELLIPSIS_TAG) || node.data === "Menu label"
          ? 59
          : 100,
        20,
      ),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 123, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(applyLayoutConstraint(constraint, "Translated label")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(layoutProtectedGeometryMatchesBaseline(homeConstraint)).toBe(false);
    node.data = constraint.originalText;
    const { wrapper } = applyLayoutConstraint(
      constraint,
      "Translated label",
      1,
      "source-only",
    );

    expect(wrapper?.style.getPropertyValue("--tryhand-inline-size")).toBe(
      "59px",
    );
    expect(node.data).toBe("Translated label");
    expect(node.parentElement).toBe(wrapper);
    expect(layoutProtectedGeometryMatchesBaseline(homeConstraint)).toBe(true);
    expect(homeIcon.getAttribute("style")).toBeNull();
  });

  it("corrects wrapper baseline displacement with a temporary numeric marker", () => {
    const { host, node } = append();
    const icon = document.createElement("span");
    host.append(icon);
    Object.defineProperty(host, "clientWidth", { value: 60 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Original text" ? 60 : 100, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Original text" ? 60 : 100, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 60, 20));
    vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() => {
      const wrapper = host.querySelector<HTMLElement>(ELLIPSIS_TAG);
      return wrapper && wrapper.style.verticalAlign !== "10px"
        ? rect(60, 9, 10, 10)
        : rect(60, 0, 10, 10);
    });
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.localName === BASELINE_MARKER_TAG)
          return rect(
            0,
            this.parentElement?.querySelector(ELLIPSIS_TAG) ? 10 : 20,
            0,
            0,
          );
        return nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    const { wrapper } = applyLayoutConstraint(constraint, "Full translation");

    expect(wrapper?.style.verticalAlign).toBe("10px");
    expect(icon.getBoundingClientRect().y).toBe(0);
    expect(host.querySelector(`.${BASELINE_MARKER_CLASS}`)).toBeNull();
  });

  it("accepts a uniform group shift while rejecting peer-relative movement", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    let groupY = 0;
    let peerY = 20;
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, groupY, node.data === "Menu label" ? 59 : 160, 14),
          getClientRects: () =>
            [
              rect(0, groupY, node.data === "Menu label" ? 59 : 160, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(0, groupY, 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() =>
      rect(0, groupY, 123, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockImplementation(() =>
      rect(0, groupY + peerY, 123, 20),
    );
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.localName === BASELINE_MARKER_TAG) {
          return rect(
            0,
            groupY +
              (this.parentElement?.querySelector(ELLIPSIS_TAG) ? 10 : 20),
            0,
            0,
          );
        }
        return nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    groupY = 40;
    const result = applyLayoutConstraint(constraint, "Long translation");

    expect(result.outcome).toBe("translated-constrained");
    expect(result.wrapper?.style.verticalAlign).toBe("10px");
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);

    peerY = 22;
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(false);
  });

  it("retains translated raw text and removes every owned node when baseline measurement fails", () => {
    const { host, node } = append();
    const icon = document.createElement("span");
    icon.className = "site-icon";
    icon.dataset.state = "open";
    icon.style.transform = "rotate(10deg)";
    host.append(icon);
    host.className = "site-control";
    host.style.color = "red";
    Object.defineProperty(host, "clientWidth", { value: 60 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Original text" ? 60 : 100, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Original text" ? 60 : 100, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 60, 20));
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(
      rect(60, 0, 10, 10),
    );
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (
          this.localName === BASELINE_MARKER_TAG &&
          this.parentElement?.querySelector(ELLIPSIS_TAG)
        ) {
          throw new Error("measurement failed");
        }
        return this.localName === BASELINE_MARKER_TAG
          ? rect(0, 20, 0, 0)
          : nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(applyLayoutConstraint(constraint, "Readable translation")).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(node.data).toBe("Readable translation");
    expect(node.parentElement).toBe(host);
    expect(host.querySelector(ELLIPSIS_TAG)).toBeNull();
    expect(host.querySelector(BASELINE_MARKER_TAG)).toBeNull();
    expect(host.className).toBe("site-control");
    expect(host.getAttribute("style")).toBe("color: red;");
    expect(icon.className).toBe("site-icon");
    expect(icon.dataset.state).toBe("open");
    expect(icon.getAttribute("style")).toBe("transform: rotate(10deg);");
  });

  it("retries a constrained wrapper from the source footprint with the same Text", () => {
    const { host, node } = append();
    Object.defineProperty(host, "clientWidth", { value: 60 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Full translation" ? 100 : 60, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Full translation" ? 100 : 60, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 60, 20));
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(applyLayoutConstraint(constraint, "Full translation")).toMatchObject(
      { outcome: "translated-constrained" },
    );
    const wrapper = constraint.wrapper;
    expect(wrapper?.firstChild).toBe(node);

    expect(
      applyLayoutConstraint(constraint, "Fitting retry", 1, "source-only"),
    ).toEqual({ outcome: "translated-raw", wrapper: null });
    expect(node.parentElement).toBe(host);
    expect(host.firstChild).toBe(node);
    expect(constraint.wrapper).toBeNull();
    expect(host.querySelector(ELLIPSIS_TAG)).toBeNull();
  });

  it("restores the exact Text identity and removes owned marker and wrapper styles", () => {
    const { host, node } = append();
    const original = node.data;
    Object.defineProperty(host, "clientWidth", { value: 60 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === "Original text" ? 60 : 100, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === "Original text" ? 60 : 100, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 60, 20));
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    expect(applyLayoutConstraint(constraint, "Full translation")).toMatchObject(
      { outcome: "translated-constrained" },
    );

    unwrapLayoutConstraint(node);
    unwrapLayoutConstraint(node);
    node.data = original;

    expect(host.firstChild).toBe(node);
    expect(host.childNodes).toHaveLength(1);
    expect(node.data).toBe("Original text");
    expect(host.querySelector(ELLIPSIS_TAG)).toBeNull();
    expect(host.querySelector(BASELINE_MARKER_TAG)).toBeNull();
    expect(host.getAttribute("style")).toBeNull();
  });

  it("uses a one-pixel default compatibility tolerance and fails open above it", () => {
    const { host, node } = append();
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint) return;

    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 102, 20),
    );
    expect(layoutConstraintMatchesBaseline(constraint)).toBe(false);
    unwrapLayoutConstraint(node);
    expect(node.parentElement).toBe(host);
  });

  it("rejects a wrapper that extends past its selected host cell", () => {
    const { host, node } = append();
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint?.wrapper) return;
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this === constraint.wrapper
          ? rect(0, 0, 102, 20)
          : nativeRect.call(this);
      },
    );

    expect(layoutConstraintMatchesBaseline(constraint)).toBe(false);
  });

  it("falls back to the original text width when host capacity changes its footprint", () => {
    const { host, node } = append("a");
    host.setAttribute("href", "#nav");
    host.style.display = "block";
    host.style.paddingInlineStart = "10px";
    host.style.paddingInlineEnd = "15px";
    Object.defineProperty(host, "clientWidth", { value: 150 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 100, 14)],
      rect(0, 0, 100, 14),
      rect(0, 0, 150, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint?.wrapper) return;

    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      constraint.wrapper?.style.getPropertyValue("--tryhand-inline-size") ===
      "100px"
        ? rect(0, 0, 150, 20)
        : rect(0, 0, 175, 20),
    );

    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);
    expect(
      constraint.wrapper.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("100px");
  });

  it("accepts a larger stable ancestor when only the text host widens", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const peer = document.createElement("li");
    const host = document.createElement("a");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    item.append(host);
    list.append(item, peer);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(0, 20, 123, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint?.wrapper) return;
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      constraint.wrapper?.style.getPropertyValue("--tryhand-inline-size") ===
      "123px"
        ? rect(0, 0, 123, 20)
        : rect(0, 0, 59, 20),
    );

    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);
    expect(
      constraint.wrapper.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("123px");
  });

  it("rejects a stable-cell candidate that moves a visible layout sibling", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const cell = document.createElement("div");
    const host = document.createElement("a");
    const icon = document.createElement("span");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node);
    cell.append(host, icon);
    item.append(cell);
    list.append(item);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(cell, "clientWidth", { value: 123 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() =>
      host
        .querySelector<HTMLElement>(ELLIPSIS_TAG)
        ?.style.getPropertyValue("--tryhand-inline-size") === "123px"
        ? rect(123, 0, 10, 20)
        : rect(59, 0, 10, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint?.wrapper) return;

    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);
    expect(
      constraint.wrapper.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("59px");
  });

  it("rejects a stable-cell candidate that shifts an inline icon beside the text", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const host = document.createElement("a");
    const icon = document.createElement("span");
    const node = document.createTextNode("Menu label");
    host.href = "#menu";
    host.style.display = "block";
    host.append(node, icon);
    item.append(host);
    list.append(item);
    document.body.append(list);
    Object.defineProperty(host, "clientWidth", { value: 59 });
    Object.defineProperty(item, "clientWidth", { value: 123 });
    stubGeometry(
      node,
      host,
      [rect(0, 0, 59, 14)],
      rect(0, 0, 59, 14),
      rect(0, 0, 59, 20),
    );
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 123, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() =>
      host
        .querySelector<HTMLElement>(ELLIPSIS_TAG)
        ?.style.getPropertyValue("--tryhand-inline-size") === "123px"
        ? rect(123, 0, 10, 20)
        : rect(59, 0, 10, 20),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint?.wrapper) return;

    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);
    expect(
      constraint.wrapper.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("59px");
  });

  it("accepts page movement while detecting a single-line text baseline change", () => {
    const { host, node } = append();
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint?.wrapper) return;

    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(10, 8, 100, 20),
    );
    vi.spyOn(constraint.wrapper, "getBoundingClientRect").mockReturnValue(
      rect(10, 8, 100, 20),
    );
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () => rect(10, 8, 100, 20),
          getClientRects: () => [] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);

    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () => rect(12, 8, 100, 20),
          getClientRects: () => [] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    expect(layoutConstraintMatchesBaseline(constraint)).toBe(false);
  });

  it("allows multi-line text re-fragmenting while still rejecting host movement", () => {
    const list = document.createElement("ul");
    const host = document.createElement("li");
    const peer = document.createElement("li");
    const node = document.createTextNode("Card teaser");
    host.append(node);
    host.style.lineHeight = "20px";
    list.append(host, peer);
    document.body.append(list);
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(rect());
    stubGeometry(
      node,
      host,
      [rect(0, 0, 100, 20), rect(0, 20, 90, 20)],
      rect(0, 0, 100, 37),
      rect(0, 0, 220, 40),
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint && installLayoutConstraint(constraint)).toBe(true);
    if (!constraint) return;

    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () => rect(10, 10, 180, 60),
          getClientRects: () => [] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(10, 8, 220, 40),
    );
    expect(layoutConstraintMatchesBaseline(constraint)).toBe(true);
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(10, 8, 222, 40),
    );
    expect(layoutConstraintMatchesBaseline(constraint)).toBe(false);
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(false);
  });

  it("fails safely for detached nodes and caught wrapper errors", () => {
    const detached = document.createTextNode("Detached");
    expect(captureLayoutConstraint(detached)).toBeNull();

    const { host, node } = append();
    stubGeometry(node, host);
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    vi.spyOn(host, "insertBefore").mockImplementation(() => {
      throw new Error("host rejected wrapper");
    });
    expect(installLayoutConstraint(constraint)).toBe(false);
    expect(node.parentElement).toBe(host);
    expect(constraint.wrapper).toBeNull();
  });

  it("keeps fitting English raw in a stretched icon+text control", () => {
    const host = document.createElement("button");
    const icon = document.createElement("span");
    const node = document.createTextNode("請求書");
    const translated = "List of invoices";
    host.style.display = "flex";
    host.style.padding = "0px";
    host.style.border = "0px";
    host.append(icon, node);
    document.body.append(host);
    Object.defineProperty(host, "clientWidth", { value: 280 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(32, 0, node.data === translated ? 120 : 40, 14),
          getClientRects: () =>
            [
              rect(32, 0, node.data === translated ? 120 : 40, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 280, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 20));
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(applyLayoutConstraint(constraint, translated)).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(node.data).toBe(translated);
    expect(node.parentElement).toBe(host);
    expect(host.querySelector(ELLIPSIS_TAG)).toBeNull();
    expect(host.title).toBe("");
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
    expect(icon.getBoundingClientRect()).toMatchObject({ x: 0, width: 24 });
    expect(host.getBoundingClientRect().width).toBe(280);
  });

  it("constrains overflowing English in a stretched icon+text control", () => {
    const host = document.createElement("button");
    const icon = document.createElement("span");
    const node = document.createTextNode("請求書");
    const translated = "List of invoices and payment history";
    host.style.display = "flex";
    host.style.padding = "0px";
    host.style.border = "0px";
    host.append(icon, node);
    document.body.append(host);
    Object.defineProperty(host, "clientWidth", { value: 280 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(32, 0, node.data === translated ? 300 : 40, 14),
          getClientRects: () =>
            [
              rect(32, 0, node.data === translated ? 300 : 40, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 280, 20),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 20));
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.localName === ELLIPSIS_TAG) return rect(32, 0, 248, 20);
        if (this.localName === BASELINE_MARKER_TAG) return rect(32, 14, 0, 0);
        return nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, translated);

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.title).toBe(translated);
    expect(node.data).toBe(translated);
    expect(
      result.wrapper?.style.getPropertyValue("--tryhand-inline-size"),
    ).toBe("248px");
    expect(host.getBoundingClientRect().width).toBe(280);
    expect(icon.getBoundingClientRect()).toMatchObject({ x: 0, width: 24 });
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);
  });

  it("protects shrink-to-fit action geometry beside a peer control", () => {
    const group = document.createElement("div");
    const host = document.createElement("button");
    const peer = document.createElement("button");
    const node = document.createTextNode("新規");
    const translated = "New invoice";
    host.style.paddingInlineStart = "6px";
    host.style.paddingInlineEnd = "6px";
    host.append(node);
    group.append(host, peer);
    document.body.append(group);
    Object.defineProperty(host, "clientWidth", { value: 48 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(6, 0, node.data === translated ? 90 : 36, 14),
          getClientRects: () =>
            [
              rect(6, 0, node.data === translated ? 90 : 36, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() =>
      rect(
        0,
        0,
        node.data === translated && !host.querySelector(ELLIPSIS_TAG)
          ? 102
          : 48,
        20,
      ),
    );
    vi.spyOn(peer, "getBoundingClientRect").mockReturnValue(
      rect(56, 0, 48, 20),
    );
    vi.spyOn(group, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 120, 20),
    );
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.localName === ELLIPSIS_TAG) return rect(6, 0, 36, 20);
        if (this.localName === BASELINE_MARKER_TAG) return rect(6, 14, 0, 0);
        return nativeRect.call(this);
      },
    );
    const constraint = captureLayoutConstraint(node);
    expect(constraint?.inlineCandidates).toMatchObject([
      { inlineSize: 36, capacity: "source" },
    ]);
    if (!constraint) return;

    const result = applyLayoutConstraint(constraint, translated);

    expect(result).toMatchObject({ outcome: "translated-constrained" });
    expect(result.wrapper?.title).toBe(translated);
    expect(node.data).toBe(translated);
    expect(host.getBoundingClientRect().width).toBe(48);
    expect(group.getBoundingClientRect().width).toBe(120);
    expect(peer.getBoundingClientRect().x).toBe(56);
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(true);

    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 102, 20),
    );
    expect(layoutProtectedGeometryMatchesBaseline(constraint)).toBe(false);
  });

  it("keeps translated raw text when an unsupported wrapper cannot install", () => {
    const { host, node } = append();
    const translated = "Readable translation";
    Object.defineProperty(host, "clientWidth", { value: 60 });
    vi.spyOn(node.ownerDocument, "createRange").mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getBoundingClientRect: () =>
            rect(0, 0, node.data === translated ? 100 : 60, 14),
          getClientRects: () =>
            [
              rect(0, 0, node.data === translated ? 100 : 60, 14),
            ] as unknown as DOMRectList,
        }) as unknown as Range,
    );
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 60, 20));
    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    if (!constraint) return;
    vi.spyOn(host, "insertBefore").mockImplementation(() => {
      throw new Error("host rejected wrapper");
    });

    expect(applyLayoutConstraint(constraint, translated)).toEqual({
      outcome: "translated-raw",
      wrapper: null,
    });
    expect(node.data).toBe(translated);
    expect(node.data).not.toBe(constraint.originalText);
    expect(node.parentElement).toBe(host);
    expect(host.querySelector(ELLIPSIS_TAG)).toBeNull();
  });
});

describe("content-hugging clipped labels", () => {
  it("continues the capacity walk past a clipped shrink-to-fit label", () => {
    const nav = document.createElement("nav");
    const anchor = document.createElement("a");
    const icon = document.createElement("span");
    const label = document.createElement("span");
    const node = document.createTextNode("Menu item");
    anchor.href = "#menu";
    anchor.style.display = "flex";
    anchor.style.paddingInlineStart = "14px";
    anchor.style.paddingInlineEnd = "14px";
    label.style.display = "block";
    label.style.overflowX = "hidden";
    label.style.whiteSpace = "nowrap";
    label.style.padding = "0";
    label.style.border = "0";
    label.append(node);
    anchor.append(icon, label);
    nav.append(anchor);
    document.body.append(nav);
    Object.defineProperty(label, "clientWidth", { value: 70 });
    Object.defineProperty(anchor, "clientWidth", { value: 221 });
    stubGeometry(
      node,
      label,
      [rect(60, 0, 70, 20)],
      rect(60, 0, 70, 20),
      rect(60, 0, 70, 20),
    );
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      rect(12, 0, 221, 40),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(
      rect(26, 10, 20, 20),
    );

    expect(captureLayoutConstraint(node)).toMatchObject({
      mode: "single-line",
      inlineSize: 159,
      inlineCandidates: [{ inlineSize: 70 }, { inlineSize: 159 }],
    });
  });

  it("stops at an authored clipped block whose content coincidentally fills it", () => {
    const section = document.createElement("section");
    const anchor = document.createElement("a");
    const wrap = document.createElement("div");
    const node = document.createTextNode("Menu item");
    anchor.href = "#menu";
    anchor.style.display = "block";
    wrap.style.display = "block";
    wrap.style.overflowX = "hidden";
    wrap.style.whiteSpace = "nowrap";
    wrap.style.padding = "0";
    wrap.style.border = "0";
    wrap.append(node);
    anchor.append(wrap);
    section.append(anchor);
    document.body.append(section);
    Object.defineProperty(wrap, "clientWidth", { value: 70 });
    Object.defineProperty(anchor, "clientWidth", { value: 600 });
    stubGeometry(
      node,
      wrap,
      [rect(0, 0, 70, 20)],
      rect(0, 0, 70, 20),
      rect(0, 0, 70, 20),
    );
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 600, 20),
    );

    const constraint = captureLayoutConstraint(node);
    expect(constraint).not.toBeNull();
    expect(constraint?.inlineCandidates).toHaveLength(1);
    expect(constraint?.inlineSize).toBe(70);
  });
});
