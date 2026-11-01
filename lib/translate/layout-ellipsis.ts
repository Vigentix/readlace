/** Class name for the extension-owned layout wrapper. */
export const ELLIPSIS_TAG = "tryhand-ellipsis";
export const ELLIPSIS_CLASS = "tryhand-ellipsis";
export const BASELINE_MARKER_TAG = "tryhand-baseline-marker";
export const BASELINE_MARKER_CLASS = "tryhand-baseline-marker";

export type LayoutMode = "flow" | "single-line" | "multi-line";
export type LayoutCapacityPolicy = "largest-safe" | "source-only";
export type LayoutApplicationResult =
  | { outcome: "translated-raw"; wrapper: null }
  | { outcome: "translated-constrained"; wrapper: HTMLElement };

export interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ProtectedRect {
  element: Element;
  rect: RectSnapshot;
}

interface InlineCandidate {
  inlineSize: number;
  capacity: "source" | "dedicated";
  stableAncestor: ProtectedRect | null;
  siblings: ProtectedRect[];
}

export interface LayoutConstraint {
  node: Text;
  host: Element;
  originalText: string;
  mode: Exclude<LayoutMode, "flow">;
  inlineSize: number;
  blockSize: number;
  lineCount: number;
  baselineTextRect: RectSnapshot;
  baselineHostRect: RectSnapshot;
  preserveInlineFootprint: boolean;
  baseline: number | null;
  generatedContentOwners: ProtectedRect[];
  inlineCandidates: InlineCandidate[];
  selectedCandidate: InlineCandidate | null;
  wrapper: HTMLElement | null;
}

const INLINE_DISPLAYS = new Set(["inline", "contents"]);
const CLIPPED_OVERFLOW = new Set(["hidden", "clip", "auto", "scroll"]);
const CONTROL_TAGS = new Set([
  "BUTTON",
  "INPUT",
  "SELECT",
  "OPTION",
  "SUMMARY",
]);
const CONTROL_ROLES = new Set([
  "button",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
]);
const NAVIGATION_ROLES = new Set(["navigation", "menubar", "menu"]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

function snapshot(rect: DOMRect | ClientRect): RectSnapshot | null {
  const result = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function isVisible(rect: RectSnapshot | null): rect is RectSnapshot {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function textRect(node: Text): RectSnapshot | null {
  try {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    return snapshot(range.getBoundingClientRect());
  } catch {
    return null;
  }
}

function inlineBaseline(reference: Node): number | null {
  const parent = reference.parentNode;
  const ownerDocument = reference.ownerDocument;
  if (!parent || !ownerDocument) return null;

  let marker: HTMLElement | null = null;
  try {
    marker = ownerDocument.createElement(BASELINE_MARKER_TAG);
    marker.classList.add(BASELINE_MARKER_CLASS);
    for (const [property, value] of [
      ["display", "inline-block"],
      ["inline-size", "0"],
      ["block-size", "0"],
      ["padding", "0"],
      ["margin", "0"],
      ["border", "0"],
      ["line-height", "0"],
      ["vertical-align", "baseline"],
    ] as const) {
      marker.style.setProperty(property, value, "important");
    }
    parent.insertBefore(marker, reference.nextSibling);
    const rect = snapshot(marker.getBoundingClientRect());
    return rect ? rect.y + rect.height : null;
  } catch {
    return null;
  } finally {
    marker?.remove();
  }
}

function isVisibleInFlowPseudo(style: CSSStyleDeclaration): boolean {
  const content = style.content.trim();
  return (
    content !== "" &&
    content !== "none" &&
    content !== "normal" &&
    content !== '""' &&
    content !== "''" &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.position !== "absolute" &&
    style.position !== "fixed" &&
    (!style.cssFloat || style.cssFloat === "none")
  );
}

function hasVisibleGeneratedContent(element: Element): boolean {
  return ["::before", "::after"].some((pseudo) => {
    try {
      return isVisibleInFlowPseudo(getComputedStyle(element, pseudo));
    } catch {
      return false;
    }
  });
}

/** Used inline size of an in-flow pseudo, or null when it exists but is unmeasurable. */
function inFlowPseudoUsedInlineSize(
  element: Element,
  pseudo: "::before" | "::after",
): number | null {
  try {
    const style = getComputedStyle(element, pseudo);
    if (!isVisibleInFlowPseudo(style)) return 0;
    const width = Number.parseFloat(style.width);
    if (!Number.isFinite(width) || width <= 0) return null;
    const marginStart = Number.parseFloat(style.marginInlineStart);
    const marginEnd = Number.parseFloat(style.marginInlineEnd);
    return (
      width +
      (Number.isFinite(marginStart) ? marginStart : 0) +
      (Number.isFinite(marginEnd) ? marginEnd : 0)
    );
  } catch {
    return 0;
  }
}

/** Horizontal padding plus border of an element's used border-box. */
function horizontalPaddingBorder(element: Element): number {
  const style = getComputedStyle(element);
  const start = Number.parseFloat(style.paddingInlineStart);
  const end = Number.parseFloat(style.paddingInlineEnd);
  const borderStart = Number.parseFloat(style.borderLeftWidth);
  const borderEnd = Number.parseFloat(style.borderRightWidth);
  return (
    (Number.isFinite(start) ? start : 0) +
    (Number.isFinite(end) ? end : 0) +
    (Number.isFinite(borderStart) ? borderStart : 0) +
    (Number.isFinite(borderEnd) ? borderEnd : 0)
  );
}

/** True when used border-box matches source glyphs, with or without chrome. */
function isShrinkToFitUsedWidth(
  usedWidth: number,
  sourceTextWidth: number,
  chrome: number,
  tolerancePx = 1,
): boolean {
  return (
    Math.abs(usedWidth - sourceTextWidth) <= tolerancePx ||
    Math.abs(usedWidth - (sourceTextWidth + chrome)) <= tolerancePx
  );
}

/** True for a wrapping flex container that must not donate row-wide capacity. */
function isWrappingFlex(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    style.display.toLowerCase().includes("flex") &&
    style.flexWrap.toLowerCase().startsWith("wrap")
  );
}

function generatedContentOwners(
  node: Text,
  interactive: Element | null,
): ProtectedRect[] {
  const owners = new Set<Element>();
  if (node.parentElement) owners.add(node.parentElement);
  if (interactive) owners.add(interactive);

  const protectedOwners: ProtectedRect[] = [];
  for (const element of owners) {
    const hasVisiblePseudo = hasVisibleGeneratedContent(element);
    let hasBackgroundImage = false;
    if (element === node.parentElement) {
      try {
        const backgroundImage =
          getComputedStyle(element).backgroundImage.trim();
        hasBackgroundImage =
          backgroundImage !== "" && backgroundImage.toLowerCase() !== "none";
      } catch {
        // Host CSSOM is best-effort; never mutate the host to compensate.
      }
    }
    if (!hasVisiblePseudo && !hasBackgroundImage) continue;
    try {
      const rect = snapshot(element.getBoundingClientRect());
      if (isVisible(rect)) protectedOwners.push({ element, rect });
    } catch {
      // Pseudo CSSOM is best-effort; never mutate the host to compensate.
    }
  }
  return protectedOwners;
}

function lineCount(node: Text): number | null {
  try {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const fragments = Array.from(range.getClientRects())
      .map(snapshot)
      .filter(isVisible)
      .sort((left, right) => left.y - right.y);
    if (!fragments.length) return null;
    // Fragments of one visual line can report slightly different y values,
    // so a new line needs a jump of at least half the previous fragment.
    return fragments.reduce((count, fragment, index) => {
      const previous = fragments[index - 1];
      if (!previous) return count;
      const threshold = Math.max(0.5, previous.height / 2);
      return count + (fragment.y - previous.y > threshold ? 1 : 0);
    }, 1);
  } catch {
    return null;
  }
}

function nearestTextBlock(node: Text): Element | null {
  let element = node.parentElement;
  while (element) {
    const display = getComputedStyle(element).display.toLowerCase();
    if (!INLINE_DISPLAYS.has(display)) return element;
    element = element.parentElement;
  }
  return null;
}

function nearestInteractive(node: Text): Element | null {
  let element = node.parentElement;
  while (element) {
    const role = element.getAttribute("role")?.toLowerCase();
    if (
      element.tagName === "A" ||
      CONTROL_TAGS.has(element.tagName) ||
      (role && CONTROL_ROLES.has(role))
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

function hasNavigationContext(node: Text): boolean {
  let element = node.parentElement;
  while (element) {
    if (element.tagName === "NAV") return true;
    const role = element.getAttribute("role")?.toLowerCase();
    if (role && NAVIGATION_ROLES.has(role)) return true;
    element = element.parentElement;
  }
  return false;
}

function interactiveOwnsBlock(
  interactive: Element | null,
  host: Element,
): boolean {
  if (!interactive) return false;
  if (interactive === host || CONTROL_TAGS.has(interactive.tagName))
    return true;
  return !INLINE_DISPLAYS.has(
    getComputedStyle(interactive).display.toLowerCase(),
  );
}

function hasRepeatedPeers(host: Element): boolean {
  for (
    let item: Element | null = host;
    item?.parentElement;
    item = item.parentElement
  ) {
    const parent = item.parentElement;
    if (
      item.tagName !== "LI" ||
      (parent.tagName !== "UL" && parent.tagName !== "OL")
    ) {
      continue;
    }

    const peers = Array.from(parent.children).filter(
      (peer) =>
        peer !== item &&
        peer.tagName === item.tagName &&
        isVisible(snapshot(peer.getBoundingClientRect())),
    );
    if (peers.length) return true;
  }
  return false;
}

function hasAuthoredBound(host: Element): boolean {
  const style = getComputedStyle(host);
  const lineClamp = style.getPropertyValue("-webkit-line-clamp").trim();
  if (lineClamp && lineClamp !== "none" && lineClamp !== "0") return true;
  if (style.whiteSpace === "nowrap" || style.whiteSpace === "pre") return true;
  if (CLIPPED_OVERFLOW.has(style.overflowX)) return true;
  const hasBlockBound =
    (style.height !== "auto" && style.height !== "") ||
    (style.maxHeight !== "none" && style.maxHeight !== "");
  return hasBlockBound && CLIPPED_OVERFLOW.has(style.overflowY);
}

function isBoundedArticleHeading(host: Element, lines: number): boolean {
  return (
    lines > 1 &&
    HEADING_TAGS.has(host.tagName) &&
    Boolean(host.closest("article"))
  );
}

function supportsHorizontalLayout(host: Element): boolean {
  const writingMode =
    getComputedStyle(host).writingMode ||
    getComputedStyle(host).getPropertyValue("writing-mode");
  return !writingMode || writingMode.toLowerCase().startsWith("horizontal");
}

function isUnsupported(node: Text, host: Element): boolean {
  return (
    !node.isConnected ||
    !host.isConnected ||
    !node.data.trim() ||
    node.parentElement?.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    Boolean(node.parentElement?.isContentEditable) ||
    !supportsHorizontalLayout(host)
  );
}

function multiLineBlockSize(
  host: Element,
  lineCount: number,
  baselineTextRect: RectSnapshot,
  baselineHostRect: RectSnapshot,
): number {
  const lineHeight = Number.parseFloat(getComputedStyle(host).lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return lineHeight * lineCount;
  }
  return Math.max(baselineTextRect.height, baselineHostRect.height);
}

function singleLineBlockSize(
  host: Element,
  baselineTextRect: RectSnapshot,
): number {
  const lineHeight = Number.parseFloat(getComputedStyle(host).lineHeight);
  return !CONTROL_TAGS.has(host.tagName) &&
    Number.isFinite(lineHeight) &&
    lineHeight > 0
    ? lineHeight
    : baselineTextRect.height;
}

function contentBoxInlineSize(element: Element): number | null {
  const style = getComputedStyle(element);
  const inlineSize =
    element.clientWidth -
    Number.parseFloat(style.paddingInlineStart) -
    Number.parseFloat(style.paddingInlineEnd);
  return Number.isFinite(inlineSize) && inlineSize > 0 ? inlineSize : null;
}

function dedicatedInlineSize(
  element: Element,
  node: Text,
  text: RectSnapshot,
  siblings: ProtectedRect[],
): number | null {
  const elementRect = snapshot(element.getBoundingClientRect());
  const contentSize = contentBoxInlineSize(element);
  if (!isVisible(elementRect) || !contentSize) return null;

  const style = getComputedStyle(element);
  const contentStart =
    elementRect.x +
    element.clientLeft +
    Number.parseFloat(style.paddingInlineStart);
  let contentEnd = contentStart + contentSize;
  // Growing text also pushes the end-side chrome of every element between
  // the node and this owner (an anchor's padding inside a list item), so
  // that chrome is not usable capacity.
  for (
    let between = node.parentElement;
    between && between !== element;
    between = between.parentElement
  ) {
    const betweenStyle = getComputedStyle(between);
    const paddingEnd = Number.parseFloat(betweenStyle.paddingRight);
    const borderStyle = betweenStyle.borderRightStyle;
    const borderEnd =
      borderStyle && borderStyle !== "none" && borderStyle !== "hidden"
        ? Number.parseFloat(betweenStyle.borderRightWidth)
        : 0;
    const marginEnd = Number.parseFloat(betweenStyle.marginRight);
    contentEnd -=
      (Number.isFinite(paddingEnd) ? paddingEnd : 0) +
      (Number.isFinite(borderEnd) ? borderEnd : 0) +
      (Number.isFinite(marginEnd) ? marginEnd : 0);
  }
  if (
    !Number.isFinite(contentStart) ||
    !Number.isFinite(contentEnd) ||
    text.x < contentStart - 0.5 ||
    text.x >= contentEnd
  ) {
    return null;
  }

  for (const { element: sibling, rect } of siblings) {
    const siblingStyle = getComputedStyle(sibling);
    if (
      siblingStyle.position === "absolute" ||
      siblingStyle.position === "fixed" ||
      (siblingStyle.cssFloat && siblingStyle.cssFloat !== "none")
    ) {
      continue;
    }
    const sharesLine =
      rect.y < text.y + text.height - 0.5 &&
      rect.y + rect.height > text.y + 0.5;
    if (!sharesLine) continue;
    if (rect.x > text.x + 0.5) {
      contentEnd = Math.min(contentEnd, rect.x - inlineGap(node, sibling));
    } else if (rect.x + rect.width > text.x + 0.5) {
      return null;
    }
  }

  const beforeSize = inFlowPseudoUsedInlineSize(element, "::before");
  const afterSize = inFlowPseudoUsedInlineSize(element, "::after");
  if (beforeSize === null || afterSize === null) return null;
  if (afterSize > 0) contentEnd -= afterSize;
  if (beforeSize > 0 && text.x < contentStart + beforeSize - 0.5) {
    contentEnd -= beforeSize;
  }

  const inlineSize = contentEnd - text.x;
  return Number.isFinite(inlineSize) && inlineSize > 0 ? inlineSize : null;
}

function containerColumnGap(parent: Element): number {
  const style = getComputedStyle(parent);
  const display = style.display.toLowerCase();
  if (
    (!display.includes("flex") && !display.includes("grid")) ||
    (display.includes("flex") &&
      style.flexDirection.toLowerCase().startsWith("column"))
  ) {
    return 0;
  }
  const gap = Number.parseFloat(style.columnGap);
  return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

function inlineGap(node: Text, sibling: Element): number {
  const parent = sibling.parentElement;
  if (!parent) return 0;
  let branch: Node = node;
  while (branch.parentNode && branch.parentNode !== parent) {
    branch = branch.parentNode;
  }
  if (branch.parentNode !== parent || branch === sibling) return 0;
  return containerColumnGap(parent);
}

function isOutOfFlow(style: CSSStyleDeclaration): boolean {
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.position === "absolute" ||
    style.position === "fixed" ||
    Boolean(style.cssFloat && style.cssFloat !== "none")
  );
}

/**
 * True when the used inline size is content-driven and hugs the in-flow
 * content on one line. A block-level box in normal flow never hugs: its used
 * width is stretched or authored, so a coincidental exact fill must not make
 * it look content-driven.
 */
function hugsInlineContent(element: Element): boolean {
  const rect = snapshot(element.getBoundingClientRect());
  if (!isVisible(rect)) return false;
  const style = getComputedStyle(element);
  const display = style.display.toLowerCase();
  const parentDisplay = element.parentElement
    ? getComputedStyle(element.parentElement).display.toLowerCase()
    : "";
  const shrinkToFitContext =
    display.startsWith("inline") ||
    parentDisplay.includes("flex") ||
    parentDisplay.includes("grid") ||
    (style.cssFloat && style.cssFloat !== "none") ||
    style.position === "absolute" ||
    style.position === "fixed";
  if (!shrinkToFitContext) return false;
  let contentSize = 0;
  let itemCount = 0;
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) {
      if (!child.textContent?.trim()) continue;
      const childRect = textRect(child as Text);
      if (!isVisible(childRect)) continue;
      contentSize += childRect.width;
      itemCount += 1;
      continue;
    }
    if (child.nodeType !== 1) continue;
    const childElement = child as Element;
    const style = getComputedStyle(childElement);
    if (isOutOfFlow(style)) continue;
    const childRect = snapshot(childElement.getBoundingClientRect());
    if (!childRect || childRect.width <= 0) continue;
    const marginStart = Number.parseFloat(style.marginInlineStart);
    const marginEnd = Number.parseFloat(style.marginInlineEnd);
    contentSize +=
      childRect.width +
      (Number.isFinite(marginStart) ? marginStart : 0) +
      (Number.isFinite(marginEnd) ? marginEnd : 0);
    itemCount += 1;
  }
  if (!itemCount) return false;
  contentSize += containerColumnGap(element) * (itemCount - 1);
  contentSize += horizontalPaddingBorder(element);
  const beforeSize = inFlowPseudoUsedInlineSize(element, "::before");
  const afterSize = inFlowPseudoUsedInlineSize(element, "::after");
  if (beforeSize === null || afterSize === null) return false;
  contentSize += beforeSize + afterSize;
  return Math.abs(rect.width - contentSize) <= 1.5;
}

function nearestOwnershipBoundary(
  node: Text,
  interactive: Element | null,
): Element | null {
  for (
    let element = node.parentElement;
    element;
    element = element.parentElement
  ) {
    if (element.tagName === "LI") return element;
  }
  return interactive;
}

function protectedSiblings(node: Text, boundary: Element): ProtectedRect[] {
  const snapshots = new Map<Element, RectSnapshot>();
  for (
    let current: Node | null = node;
    current;
    current = current.parentElement
  ) {
    const parent: Element | null = current.parentElement;
    if (parent) {
      for (const sibling of Array.from<Element>(parent.children)) {
        if (sibling === current || snapshots.has(sibling)) continue;
        const style = getComputedStyle(sibling);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.position === "absolute" ||
          style.position === "fixed" ||
          (style.cssFloat && style.cssFloat !== "none")
        ) {
          continue;
        }
        const rect = snapshot(sibling.getBoundingClientRect());
        if (isVisible(rect)) snapshots.set(sibling, rect);
      }
    }
    if (current === boundary) break;
  }
  return Array.from(snapshots, ([element, rect]) => ({ element, rect }));
}

/** True when the host renders any visible text besides this node's own. */
function hasOtherVisibleText(node: Text, host: Element): boolean {
  const walker = node.ownerDocument.createTreeWalker(
    host,
    NodeFilter.SHOW_TEXT,
  );
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node || !current.textContent?.trim()) continue;
    if (isVisible(textRect(current as Text))) return true;
  }
  return false;
}

function hasVisibleTextSibling(node: Text, boundary: Element): boolean {
  for (
    let current: Node | null = node;
    current && current !== boundary;
    current = current.parentElement
  ) {
    const parent: Element | null = current.parentElement;
    if (!parent) return true;
    for (const sibling of Array.from(parent.childNodes)) {
      if (
        sibling !== current &&
        sibling.nodeType === 3 &&
        sibling.textContent?.trim() &&
        isVisible(textRect(sibling as Text))
      ) {
        return true;
      }
    }
  }
  return false;
}

function inlineCandidates(
  host: Element,
  node: Text,
  originalTextWidth: number,
  interactive: Element | null,
): InlineCandidate[] {
  const boundary = nearestOwnershipBoundary(node, interactive) ?? host;
  const candidates: InlineCandidate[] = [
    {
      inlineSize: originalTextWidth,
      capacity: "source",
      stableAncestor: null,
      siblings: boundary ? protectedSiblings(node, boundary) : [],
    },
  ];

  const baselineTextRect = textRect(node);
  if (!isVisible(baselineTextRect)) return candidates;

  if (
    boundary &&
    boundary.contains(host) &&
    !hasVisibleTextSibling(node, boundary)
  ) {
    let largestDedicated = 0;
    for (
      let element: Element | null = host;
      element;
      element = element.parentElement
    ) {
      const rect = snapshot(element.getBoundingClientRect());
      const skipAncestor = element !== host && isWrappingFlex(element);
      const siblings = skipAncestor ? [] : protectedSiblings(node, element);
      const inlineSize = skipAncestor
        ? null
        : dedicatedInlineSize(element, node, baselineTextRect, siblings);
      const usedWidth = rect?.width ?? Number.NaN;
      const shrinkToFit = isShrinkToFitUsedWidth(
        usedWidth,
        originalTextWidth,
        horizontalPaddingBorder(element),
      );
      const remainingLarger =
        inlineSize !== null && inlineSize > originalTextWidth + 1;
      const remainingSmaller =
        inlineSize !== null && inlineSize < originalTextWidth;
      if (
        element.isConnected &&
        supportsHorizontalLayout(element) &&
        inlineSize !== null &&
        !shrinkToFit &&
        !hugsInlineContent(element) &&
        (remainingLarger || remainingSmaller) &&
        inlineSize > largestDedicated &&
        isVisible(rect)
      ) {
        candidates.push({
          inlineSize,
          capacity: "dedicated",
          stableAncestor: { element, rect },
          siblings,
        });
        largestDedicated = inlineSize;
      }
      if (
        CLIPPED_OVERFLOW.has(getComputedStyle(element).overflowX) &&
        !hugsInlineContent(element)
      ) {
        break;
      }
      if (element === boundary) break;
    }
  }

  return candidates;
}

/**
 * Captures the layout to preserve before translation. Bounded surfaces and
 * sole-text flow keep their captured footprint; mixed-inline flow (a node
 * sharing its block with other visible text) returns null and stays raw, so
 * sentences with inline markup are never frozen chunk by chunk.
 */
export function captureLayoutConstraint(node: Text): LayoutConstraint | null {
  const host = nearestTextBlock(node);
  if (!host || isUnsupported(node, host)) return null;

  const baselineTextRect = textRect(node);
  const baselineHostRect = snapshot(host.getBoundingClientRect());
  const lines = lineCount(node);
  if (!isVisible(baselineTextRect) || !isVisible(baselineHostRect) || !lines) {
    return null;
  }

  const interactive = nearestInteractive(node);
  const navigation = hasNavigationContext(node);
  const interactiveBlock = interactiveOwnsBlock(interactive, host);
  const repeated = hasRepeatedPeers(host);
  const bounded =
    hasAuthoredBound(host) ||
    navigation ||
    interactiveBlock ||
    repeated ||
    isBoundedArticleHeading(host, lines);
  if (!bounded && hasOtherVisibleText(node, host)) return null;

  // A source that genuinely renders multiple lines keeps its footprint with
  // a clamp; forcing it onto one line would shrink the cell it lives in.
  // Fragmented Range rects can over-count lines, so the used text height is
  // the tie-breaker.
  const hostLineHeight = Number.parseFloat(getComputedStyle(host).lineHeight);
  const heightLines =
    Number.isFinite(hostLineHeight) && hostLineHeight > 0
      ? Math.max(1, Math.round(baselineTextRect.height / hostLineHeight))
      : lines;
  const lineLimit = Math.min(lines, heightLines);
  const mode: Exclude<LayoutMode, "flow"> =
    lineLimit === 1 ? "single-line" : "multi-line";
  const generatedOwners = generatedContentOwners(node, interactive);
  const candidates =
    mode === "single-line"
      ? inlineCandidates(host, node, baselineTextRect.width, interactive)
      : [];
  return {
    node,
    host,
    originalText: node.data,
    mode,
    inlineSize:
      mode === "multi-line"
        ? baselineHostRect.width
        : (candidates[candidates.length - 1]?.inlineSize ??
          baselineTextRect.width),
    blockSize:
      mode === "multi-line"
        ? multiLineBlockSize(
            host,
            lineLimit,
            baselineTextRect,
            baselineHostRect,
          )
        : singleLineBlockSize(host, baselineTextRect),
    lineCount: lineLimit,
    baselineTextRect,
    baselineHostRect,
    preserveInlineFootprint:
      mode === "single-line" &&
      (candidates.every((candidate) => candidate.capacity === "source") ||
        hugsInlineContent(nearestOwnershipBoundary(node, interactive) ?? host)),
    baseline: null,
    generatedContentOwners: generatedOwners,
    inlineCandidates: candidates,
    selectedCandidate: null,
    wrapper: null,
  };
}

/** Recaptures current ownership geometry without ever leaving source text installed. */
export function recaptureLayoutConstraint(
  constraint: LayoutConstraint,
  translatedText: string,
): LayoutConstraint | null {
  const { node, originalText, wrapper } = constraint;
  if (
    !node.isConnected ||
    node.data !== translatedText ||
    (wrapper && node.parentElement !== wrapper)
  ) {
    return null;
  }

  if (wrapper) {
    unwrapLayoutConstraint(node);
    if (node.parentElement === wrapper || !node.isConnected) return null;
  }
  constraint.wrapper = null;
  constraint.selectedCandidate = null;
  node.data = originalText;
  try {
    return captureLayoutConstraint(node);
  } catch {
    return null;
  } finally {
    node.data = translatedText;
  }
}

function isWhitespaceText(sibling: Node | null): sibling is Text {
  return Boolean(
    sibling && sibling.nodeType === 3 && !(sibling as Text).data.trim(),
  );
}

/**
 * Installs an extension-owned wrapper around the original Text node. Adjacent
 * whitespace-only Text siblings move inside the wrapper too: left outside an
 * inline-block they stop collapsing and render as real spaces, growing the
 * host by a space width per side and breaking every freeze validation.
 */
export function installLayoutConstraint(constraint: LayoutConstraint): boolean {
  const { node, host } = constraint;
  const parent = node.parentElement;
  if (
    !parent ||
    !node.isConnected ||
    !host.isConnected ||
    parent.classList.contains(ELLIPSIS_CLASS) ||
    parent.isContentEditable
  ) {
    return false;
  }

  let wrapper: HTMLElement | null = null;
  try {
    const leading: Text[] = [];
    for (
      let sibling = node.previousSibling;
      isWhitespaceText(sibling);
      sibling = sibling.previousSibling
    ) {
      leading.unshift(sibling);
    }
    const trailing: Text[] = [];
    for (
      let sibling = node.nextSibling;
      isWhitespaceText(sibling);
      sibling = sibling.nextSibling
    ) {
      trailing.push(sibling);
    }
    wrapper = node.ownerDocument.createElement(ELLIPSIS_TAG);
    wrapper.classList.add(ELLIPSIS_CLASS);
    wrapper.dataset.tryhandLayout = constraint.mode;
    wrapper.style.padding = "0";
    if (constraint.mode === "single-line") wrapper.style.verticalAlign = "0px";
    wrapper.style.setProperty(
      "--tryhand-inline-size",
      `${constraint.inlineSize}px`,
    );
    wrapper.style.setProperty(
      "--tryhand-block-size",
      `${constraint.blockSize}px`,
    );
    wrapper.style.setProperty("--tryhand-lines", String(constraint.lineCount));
    parent.insertBefore(wrapper, leading[0] ?? node);
    for (const sibling of leading) wrapper.appendChild(sibling);
    wrapper.appendChild(node);
    for (const sibling of trailing) wrapper.appendChild(sibling);
    constraint.wrapper = wrapper;
    return true;
  } catch {
    if (wrapper?.parentNode) wrapper.replaceWith(...wrapper.childNodes);
    else wrapper?.remove();
    constraint.wrapper = null;
    return false;
  }
}

function matchesFootprint(
  left: RectSnapshot,
  right: RectSnapshot,
  tolerancePx: number,
): boolean {
  return (
    Math.abs(left.width - right.width) <= tolerancePx &&
    Math.abs(left.height - right.height) <= tolerancePx
  );
}

function relativeToHost(text: RectSnapshot, host: RectSnapshot): RectSnapshot {
  return {
    x: text.x - host.x,
    y: text.y - host.y,
    width: text.width,
    height: text.height,
  };
}

function matchesTextPlacement(
  left: RectSnapshot,
  right: RectSnapshot,
  tolerancePx: number,
): boolean {
  return (
    Math.abs(left.x - right.x) <= tolerancePx &&
    Math.abs(left.y - right.y) <= tolerancePx &&
    matchesFootprint(left, right, tolerancePx)
  );
}

function matchesHostPlacement(
  left: RectSnapshot,
  right: RectSnapshot,
  tolerancePx: number,
  includeWidth = false,
): boolean {
  return (
    Math.abs(left.x - right.x) <= tolerancePx &&
    Math.abs(left.y - right.y) <= tolerancePx &&
    Math.abs(left.height - right.height) <= tolerancePx &&
    (!includeWidth || Math.abs(left.width - right.width) <= tolerancePx)
  );
}

function containsInline(
  outer: RectSnapshot,
  inner: RectSnapshot,
  tolerancePx: number,
): boolean {
  return (
    inner.x >= outer.x - tolerancePx &&
    inner.x + inner.width <= outer.x + outer.width + tolerancePx
  );
}

function protectedRectsMatchReference(
  snapshots: ProtectedRect[],
  currentReference: RectSnapshot,
  baselineReference: RectSnapshot,
  tolerancePx: number,
): boolean {
  return snapshots.every(({ element, rect }) => {
    const current = snapshot(element.getBoundingClientRect());
    return Boolean(
      element.isConnected &&
      current &&
      matchesTextPlacement(
        relativeToHost(current, currentReference),
        relativeToHost(rect, baselineReference),
        tolerancePx,
      ),
    );
  });
}

/** True while protected geometry stays aligned inside the selected cell. */
export function layoutProtectedGeometryMatchesBaseline(
  constraint: LayoutConstraint,
  tolerancePx = 1,
): boolean {
  try {
    if (!Number.isFinite(tolerancePx) || tolerancePx < 0) return false;
    if (constraint.mode === "multi-line") {
      if (!constraint.wrapper) {
        if (!rawMultiLineMatchesBaseline(constraint, tolerancePx)) return false;
      } else {
        const currentHostRect = snapshot(
          constraint.host.getBoundingClientRect(),
        );
        if (
          !currentHostRect ||
          !matchesFootprint(
            currentHostRect,
            constraint.baselineHostRect,
            tolerancePx,
          )
        ) {
          return false;
        }
      }
    }
    const candidate = constraint.selectedCandidate;
    const protectedRects = new Map<Element, ProtectedRect>();
    constraint.generatedContentOwners.forEach((item) =>
      protectedRects.set(item.element, item),
    );
    candidate?.siblings.forEach((item) => {
      if (!protectedRects.has(item.element))
        protectedRects.set(item.element, item);
    });
    if (
      constraint.mode === "single-line" &&
      !constraint.wrapper &&
      lineCount(constraint.node) !== constraint.lineCount
    ) {
      return false;
    }
    if (!protectedRects.size) {
      if (
        constraint.mode === "single-line" &&
        candidate?.capacity !== "dedicated"
      ) {
        const currentHostRect = snapshot(
          constraint.host.getBoundingClientRect(),
        );
        return Boolean(
          currentHostRect &&
          matchesFootprint(
            currentHostRect,
            constraint.baselineHostRect,
            tolerancePx,
          ),
        );
      }
      return true;
    }

    const reference = candidate?.stableAncestor;
    const referenceElement = reference?.element ?? constraint.host;
    const baselineReference = reference?.rect ?? constraint.baselineHostRect;
    const currentReference = snapshot(referenceElement.getBoundingClientRect());
    return Boolean(
      referenceElement.isConnected &&
      currentReference &&
      matchesFootprint(currentReference, baselineReference, tolerancePx) &&
      protectedRectsMatchReference(
        [...protectedRects.values()],
        currentReference,
        baselineReference,
        tolerancePx,
      ),
    );
  } catch {
    return false;
  }
}

function rawMultiLineMatchesBaseline(
  constraint: LayoutConstraint,
  tolerancePx: number,
): boolean {
  const currentHostRect = snapshot(constraint.host.getBoundingClientRect());
  const currentTextRect = textRect(constraint.node);
  const currentLines = lineCount(constraint.node);
  return Boolean(
    currentHostRect &&
    currentTextRect &&
    currentLines &&
    currentLines <= constraint.lineCount &&
    containsInline(currentHostRect, currentTextRect, tolerancePx) &&
    !(
      constraint.host.clientWidth > 0 &&
      constraint.host.scrollWidth > constraint.host.clientWidth + tolerancePx
    ) &&
    matchesFootprint(
      currentHostRect,
      constraint.baselineHostRect,
      tolerancePx,
    ) &&
    protectedRectsMatchReference(
      constraint.generatedContentOwners,
      currentHostRect,
      constraint.baselineHostRect,
      tolerancePx,
    ),
  );
}

function singleLineCandidateMatchesBaseline(
  constraint: LayoutConstraint,
  candidate: InlineCandidate,
  tolerancePx: number,
): boolean {
  const { node, host, wrapper } = constraint;
  const currentHostRect = snapshot(host.getBoundingClientRect());
  const stable = candidate.stableAncestor;
  const referenceElement = stable?.element ?? host;
  const baselineReference = stable?.rect ?? constraint.baselineHostRect;
  const currentReference = snapshot(referenceElement.getBoundingClientRect());
  const currentCellRect = stable ? currentReference : currentHostRect;
  const currentWrapperRect = wrapper
    ? snapshot(wrapper.getBoundingClientRect())
    : null;
  if (
    !currentHostRect ||
    !currentReference ||
    !currentCellRect ||
    !currentWrapperRect ||
    !referenceElement.isConnected ||
    !matchesFootprint(currentReference, baselineReference, tolerancePx) ||
    !containsInline(currentHostRect, currentWrapperRect, tolerancePx) ||
    !containsInline(currentCellRect, currentWrapperRect, tolerancePx) ||
    !(referenceElement !== host
      ? matchesHostPlacement(
          relativeToHost(currentHostRect, currentReference),
          relativeToHost(constraint.baselineHostRect, baselineReference),
          tolerancePx,
          candidate.capacity === "source",
        )
      : matchesFootprint(
          currentHostRect,
          constraint.baselineHostRect,
          tolerancePx,
        ))
  ) {
    return false;
  }

  const currentTextRect = textRect(node);
  if (
    !currentTextRect ||
    !matchesHostPlacement(
      relativeToHost(currentTextRect, currentHostRect),
      relativeToHost(constraint.baselineTextRect, constraint.baselineHostRect),
      tolerancePx,
    )
  ) {
    return false;
  }

  return (
    protectedRectsMatchReference(
      candidate.siblings,
      currentReference,
      baselineReference,
      tolerancePx,
    ) &&
    protectedRectsMatchReference(
      constraint.generatedContentOwners,
      currentReference,
      baselineReference,
      tolerancePx,
    )
  );
}

function rawCandidateMatchesBaseline(
  constraint: LayoutConstraint,
  candidate: InlineCandidate,
  tolerancePx: number,
): boolean {
  const { node, host } = constraint;
  const currentHostRect = snapshot(host.getBoundingClientRect());
  const currentTextRect = textRect(node);
  const stable = candidate.stableAncestor;
  const referenceElement = stable?.element ?? host;
  const baselineReference = stable?.rect ?? constraint.baselineHostRect;
  const currentReference = snapshot(referenceElement.getBoundingClientRect());
  if (
    !currentHostRect ||
    !currentTextRect ||
    !currentReference ||
    !referenceElement.isConnected ||
    !matchesFootprint(currentReference, baselineReference, tolerancePx) ||
    lineCount(node) !== 1
  )
    return false;

  const hostMatches =
    referenceElement !== host
      ? matchesHostPlacement(
          relativeToHost(currentHostRect, currentReference),
          relativeToHost(constraint.baselineHostRect, baselineReference),
          tolerancePx,
          candidate.capacity === "source",
        )
      : matchesFootprint(
          currentHostRect,
          constraint.baselineHostRect,
          tolerancePx,
        );
  const cellRect = stable
    ? snapshot(stable.element.getBoundingClientRect())
    : currentHostRect;
  const currentRelative = relativeToHost(currentTextRect, currentHostRect);
  const baselineRelative = relativeToHost(
    constraint.baselineTextRect,
    constraint.baselineHostRect,
  );
  if (
    !hostMatches ||
    !cellRect ||
    currentTextRect.width > candidate.inlineSize + tolerancePx ||
    !containsInline(cellRect, currentTextRect, tolerancePx) ||
    Math.abs(currentRelative.y - baselineRelative.y) > tolerancePx ||
    Math.abs(currentRelative.height - baselineRelative.height) > tolerancePx ||
    (constraint.generatedContentOwners.length > 0 &&
      !matchesTextPlacement(currentRelative, baselineRelative, tolerancePx))
  ) {
    return false;
  }

  return (
    protectedRectsMatchReference(
      candidate.siblings,
      currentReference,
      baselineReference,
      tolerancePx,
    ) &&
    protectedRectsMatchReference(
      constraint.generatedContentOwners,
      currentReference,
      baselineReference,
      tolerancePx,
    )
  );
}

/** True when the provisional wrapper preserved the captured geometry. */
export function layoutConstraintMatchesBaseline(
  constraint: LayoutConstraint,
  tolerancePx = 1,
  originalFootprintOnly = false,
): boolean {
  const { node, host, wrapper } = constraint;
  if (
    !wrapper ||
    !node.isConnected ||
    !host.isConnected ||
    !wrapper.isConnected ||
    node.parentElement !== wrapper ||
    !Number.isFinite(tolerancePx) ||
    tolerancePx < 0
  ) {
    return false;
  }

  if (constraint.mode === "multi-line") {
    const currentHostRect = snapshot(host.getBoundingClientRect());
    return Boolean(
      currentHostRect &&
      matchesFootprint(
        currentHostRect,
        constraint.baselineHostRect,
        tolerancePx,
      ),
    );
  }

  for (
    let index = originalFootprintOnly
      ? 0
      : constraint.inlineCandidates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const candidate = constraint.inlineCandidates[index];
    if (!candidate) continue;
    wrapper.style.setProperty(
      "--tryhand-inline-size",
      `${candidate.inlineSize}px`,
    );
    if (
      singleLineCandidateMatchesBaseline(constraint, candidate, tolerancePx)
    ) {
      constraint.inlineSize = candidate.inlineSize;
      constraint.selectedCandidate = candidate;
      return true;
    }
  }
  return false;
}

function correctWrapperBaseline(constraint: LayoutConstraint): boolean {
  if (constraint.mode !== "single-line") return true;
  const { baseline, host, wrapper } = constraint;
  if (baseline === null || !wrapper) return false;
  const currentHostRect = snapshot(host.getBoundingClientRect());
  const wrappedBaseline = inlineBaseline(wrapper);
  if (!currentHostRect || wrappedBaseline === null) return false;
  const correction =
    baseline -
    constraint.baselineHostRect.y -
    (wrappedBaseline - currentHostRect.y);
  if (!Number.isFinite(correction)) return false;
  wrapper.style.verticalAlign = `${correction}px`;
  return true;
}

function measuredOverflow(constraint: LayoutConstraint): boolean | null {
  const { node, wrapper } = constraint;
  if (!wrapper || node.parentElement !== wrapper || !node.isConnected)
    return null;

  const wrapperRect = snapshot(wrapper.getBoundingClientRect());
  const translatedTextRect = textRect(node);
  if (!wrapperRect || !translatedTextRect) return null;

  return (
    wrapper.scrollWidth > wrapper.clientWidth ||
    wrapper.scrollHeight > wrapper.clientHeight ||
    translatedTextRect.width > constraint.inlineSize + 0.5 ||
    translatedTextRect.width > wrapperRect.width + 0.5 ||
    translatedTextRect.height > wrapperRect.height + 0.5
  );
}

function translatedWrapperMatchesBaseline(
  constraint: LayoutConstraint,
  tolerancePx: number,
): boolean {
  const { node, host, wrapper, selectedCandidate: candidate } = constraint;
  if (!candidate || lineCount(node) !== 1) return false;

  const currentHostRect = snapshot(host.getBoundingClientRect());
  const currentTextRect = textRect(node);
  const stable = candidate.stableAncestor;
  const referenceElement = stable?.element ?? host;
  const baselineReference = stable?.rect ?? constraint.baselineHostRect;
  const currentReference = snapshot(referenceElement.getBoundingClientRect());
  const cellRect = stable
    ? snapshot(stable.element.getBoundingClientRect())
    : currentHostRect;
  const wrapperRect = wrapper
    ? snapshot(wrapper.getBoundingClientRect())
    : null;
  if (
    !currentHostRect ||
    !currentTextRect ||
    !currentReference ||
    !referenceElement.isConnected ||
    !matchesFootprint(currentReference, baselineReference, tolerancePx) ||
    !cellRect ||
    !wrapperRect ||
    !containsInline(currentHostRect, wrapperRect, tolerancePx) ||
    !containsInline(cellRect, wrapperRect, tolerancePx)
  )
    return false;

  const hostMatches =
    referenceElement !== host
      ? matchesHostPlacement(
          relativeToHost(currentHostRect, currentReference),
          relativeToHost(constraint.baselineHostRect, baselineReference),
          tolerancePx,
          candidate.capacity === "source",
        )
      : matchesFootprint(
          currentHostRect,
          constraint.baselineHostRect,
          tolerancePx,
        );
  const currentRelative = relativeToHost(currentTextRect, currentHostRect);
  const baselineRelative = relativeToHost(
    constraint.baselineTextRect,
    constraint.baselineHostRect,
  );

  return (
    hostMatches &&
    currentTextRect.x >= cellRect.x - tolerancePx &&
    currentTextRect.x <= cellRect.x + cellRect.width + tolerancePx &&
    Math.abs(currentRelative.y - baselineRelative.y) <= tolerancePx &&
    Math.abs(currentRelative.height - baselineRelative.height) <= tolerancePx &&
    protectedRectsMatchReference(
      candidate.siblings,
      currentReference,
      baselineReference,
      tolerancePx,
    ) &&
    protectedRectsMatchReference(
      constraint.generatedContentOwners,
      currentReference,
      baselineReference,
      tolerancePx,
    )
  );
}

/**
 * Validates already-installed raw translated text without touching the DOM,
 * so a batch of writes can be checked in one read pass.
 */
export function rawTranslationMatchesBaseline(
  constraint: LayoutConstraint,
  tolerancePx = 1,
): boolean {
  try {
    const { node, host } = constraint;
    if (!node.isConnected || !host.isConnected) return false;
    if (node.parentElement?.classList.contains(ELLIPSIS_CLASS)) return false;
    constraint.selectedCandidate = null;
    if (constraint.mode === "single-line") {
      for (
        let index = constraint.inlineCandidates.length - 1;
        index >= 0;
        index -= 1
      ) {
        const candidate = constraint.inlineCandidates[index];
        if (
          candidate &&
          rawCandidateMatchesBaseline(constraint, candidate, tolerancePx)
        ) {
          constraint.inlineSize = candidate.inlineSize;
          constraint.selectedCandidate = candidate;
          return true;
        }
      }
      return false;
    }
    return rawMultiLineMatchesBaseline(constraint, tolerancePx);
  } catch {
    return false;
  }
}

/** Applies translated text raw first, then constrains it synchronously if unsafe. */
export function applyLayoutConstraint(
  constraint: LayoutConstraint,
  translatedText: string,
  tolerancePx = 1,
  capacityPolicy: LayoutCapacityPolicy = "largest-safe",
): LayoutApplicationResult {
  const { node } = constraint;
  const fallback = (): LayoutApplicationResult => {
    unwrapLayoutConstraint(node);
    constraint.wrapper = null;
    constraint.selectedCandidate = null;
    node.data = translatedText;
    return { outcome: "translated-raw", wrapper: null };
  };

  try {
    constraint.selectedCandidate = null;
    if (
      capacityPolicy === "source-only" &&
      constraint.wrapper &&
      node.parentElement === constraint.wrapper
    ) {
      const wrapper = constraint.wrapper;
      unwrapLayoutConstraint(node);
      if (node.parentElement !== wrapper) constraint.wrapper = null;
    }
    if (
      !Number.isFinite(tolerancePx) ||
      tolerancePx < 0 ||
      !["largest-safe", "source-only"].includes(capacityPolicy) ||
      !node.isConnected ||
      !constraint.host.isConnected ||
      node.parentElement?.classList.contains(ELLIPSIS_CLASS)
    ) {
      return fallback();
    }

    node.data = translatedText;
    if (constraint.mode === "single-line") {
      for (
        let index =
          capacityPolicy === "source-only"
            ? 0
            : constraint.inlineCandidates.length - 1;
        index >= 0;
        index -= 1
      ) {
        const candidate = constraint.inlineCandidates[index];
        if (
          candidate &&
          rawCandidateMatchesBaseline(constraint, candidate, tolerancePx)
        ) {
          constraint.inlineSize = candidate.inlineSize;
          constraint.selectedCandidate = candidate;
          return { outcome: "translated-raw", wrapper: null };
        }
      }
    } else if (rawMultiLineMatchesBaseline(constraint, tolerancePx)) {
      return { outcome: "translated-raw", wrapper: null };
    }
    node.data = constraint.originalText;

    // The inline baseline is only needed once a wrapper is installed. It is
    // sampled now and converted into the captured host frame so the
    // correction stays valid when the whole group shifted since capture.
    if (constraint.baseline === null) {
      const sampled = inlineBaseline(node);
      const hostNow = snapshot(constraint.host.getBoundingClientRect());
      constraint.baseline =
        sampled !== null && hostNow
          ? sampled - hostNow.y + constraint.baselineHostRect.y
          : null;
    }
    if (!installLayoutConstraint(constraint)) return fallback();
    if (
      !correctWrapperBaseline(constraint) ||
      !layoutConstraintMatchesBaseline(
        constraint,
        tolerancePx,
        capacityPolicy === "source-only",
      )
    ) {
      return fallback();
    }

    node.data = translatedText;
    if (
      constraint.mode === "single-line" &&
      !translatedWrapperMatchesBaseline(constraint, tolerancePx)
    ) {
      return fallback();
    }
    const overflows = measuredOverflow(constraint);
    if (overflows === null) return fallback();
    if (overflows && constraint.wrapper)
      constraint.wrapper.title = translatedText;
    if (!constraint.wrapper) return fallback();
    return { outcome: "translated-constrained", wrapper: constraint.wrapper };
  } catch {
    return fallback();
  }
}

/**
 * Re-anchors a constraint's protected rects to current used geometry after a
 * batch of sibling applications moved them. Pure reads; returns false and
 * leaves the record for the repair routine when its state is not
 * self-consistent.
 */
export function rebaselineLayoutConstraint(
  constraint: LayoutConstraint,
): boolean {
  const { node, host, wrapper } = constraint;
  if (!node.isConnected || !host.isConnected) return false;
  if (wrapper && node.parentElement !== wrapper) return false;
  const hostRect = snapshot(host.getBoundingClientRect());
  const currentTextRect = textRect(node);
  if (!isVisible(hostRect) || !currentTextRect) return false;
  if (
    constraint.preserveInlineFootprint &&
    Math.abs(hostRect.width - constraint.baselineHostRect.width) > 1
  ) {
    return false;
  }
  if (wrapper) {
    const wrapperRect = snapshot(wrapper.getBoundingClientRect());
    if (!wrapperRect || !containsInline(hostRect, wrapperRect, 1)) {
      return false;
    }
  }
  const updates: [ProtectedRect, RectSnapshot][] = [];
  const collect = (item: ProtectedRect) => {
    if (!item.element.isConnected) return false;
    const rect = snapshot(item.element.getBoundingClientRect());
    if (!rect) return false;
    updates.push([item, rect]);
    return true;
  };
  for (const owner of constraint.generatedContentOwners) {
    if (!collect(owner)) return false;
  }
  for (const candidate of constraint.inlineCandidates) {
    if (candidate.stableAncestor && !collect(candidate.stableAncestor)) {
      return false;
    }
    for (const sibling of candidate.siblings) {
      if (!collect(sibling)) return false;
    }
  }
  const selected = constraint.selectedCandidate;
  if (selected && !constraint.inlineCandidates.includes(selected)) {
    if (selected.stableAncestor && !collect(selected.stableAncestor)) {
      return false;
    }
    for (const sibling of selected.siblings) {
      if (!collect(sibling)) return false;
    }
  }
  constraint.baselineHostRect = hostRect;
  constraint.baselineTextRect = currentTextRect;
  for (const [item, rect] of updates) item.rect = rect;
  return true;
}

/** Removes an extension wrapper while retaining every child's identity. */
export function unwrapLayoutConstraint(node: Text): void {
  const wrapper = node.parentElement;
  if (
    !wrapper ||
    wrapper.localName !== ELLIPSIS_TAG ||
    !wrapper.classList.contains(ELLIPSIS_CLASS)
  ) {
    return;
  }
  try {
    wrapper.replaceWith(...wrapper.childNodes);
  } catch {
    // A host may detach the wrapper between collection and restore.
  }
}

/** Releases a wrapper whose tracked Text moved away, keeping any children. */
export function releaseLayoutWrapper(wrapper: Element): void {
  if (
    wrapper.localName !== ELLIPSIS_TAG ||
    !wrapper.classList.contains(ELLIPSIS_CLASS)
  ) {
    return;
  }
  try {
    if (wrapper.parentNode) wrapper.replaceWith(...wrapper.childNodes);
    else wrapper.remove();
  } catch {
    // A host may detach the wrapper between collection and restore.
  }
}
