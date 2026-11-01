import {
  BASELINE_MARKER_CLASS,
  BASELINE_MARKER_TAG,
  ELLIPSIS_CLASS,
  ELLIPSIS_TAG,
} from "./layout-ellipsis";

export const INLINE_TEXT_TAGS = [
  "#text",
  "a",
  "abbr",
  "acronym",
  "b",
  "bdo",
  "big",
  "cite",
  "dfn",
  "em",
  "i",
  "label",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "u",
  "tt",
  "var",
];

export const INLINE_IGNORE_TAGS = ["br", "code", "kbd", "wbr", "pre"];

const ATOMIC_DISPLAYS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

function isAtomicBox(node: Node) {
  if (node.nodeType !== 1) return false;
  try {
    return ATOMIC_DISPLAYS.has(getComputedStyle(node as Element).display);
  } catch {
    return false;
  }
}

export const NO_TRANSLATE_TAGS = [
  "title",
  "script",
  "style",
  "textarea",
  "svg",
  "template",
  "math",
  "mjx-container",
  "tex-math",
];

export interface TranslatePiece {
  isTranslated: boolean;
  parentElement: Element | null;
  topElement: Element | null;
  bottomElement: Element | null;
  nodes: Text[];
}

export interface TranslateAttribute {
  node: Element;
  original: string;
  translated?: string;
  attribute: string;
  isTranslated: boolean;
}

export type TranslationLane = "priority" | "bulk";

export interface TranslationCollector {
  drain(budgetMs: number): {
    pieces: TranslatePiece[];
    attributes: TranslateAttribute[];
    done: boolean;
  };
}

interface PieceFrame {
  node: Node;
  lastHTMLElement: Element | null;
  lastSelectOrDataListElement: Element | null;
  stage: "enter" | "light" | "shadow";
  nextChild: ChildNode | null;
  afterBoundary: boolean;
  boundaryElement: Element | null;
}

function isNoTranslateNode(node: Element) {
  const nodeName = node.nodeName.toLowerCase();
  if (nodeName === "span" && node.classList.contains("mjx-chtml")) return true;
  if (NO_TRANSLATE_TAGS.indexOf(nodeName) === -1) return false;
  if (
    nodeName === "script" &&
    node.getAttribute("data-spotim-module") === "spotim-launcher" &&
    [...node.childNodes].some((child) => child.nodeType === 1)
  )
    return false;
  return true;
}

function emptyPiece(): TranslatePiece {
  return {
    isTranslated: false,
    parentElement: null,
    topElement: null,
    bottomElement: null,
    nodes: [],
  };
}

function createCollector(
  root: ParentNode,
  hostname: string,
  includePieces: boolean,
  includeAttributes: boolean,
): TranslationCollector {
  const completedPieces: TranslatePiece[] = [];
  const completedAttributes: TranslateAttribute[] = [];
  let currentPiece = emptyPiece();
  let currentParagraphSize = 0;
  const ignoreInline = [...INLINE_IGNORE_TAGS];
  if (
    document.body &&
    document.body.childElementCount === 1 &&
    document.body.firstChild?.nodeName.toLowerCase() === "pre"
  ) {
    const preIndex = ignoreInline.indexOf("pre");
    if (preIndex !== -1) ignoreInline.splice(preIndex, 1);
  }

  const skipElement = (node: Element) => {
    const nodeName = node.nodeName.toLowerCase();
    return (
      node.matches(
        `${ELLIPSIS_TAG}.${ELLIPSIS_CLASS}, ${BASELINE_MARKER_TAG}.${BASELINE_MARKER_CLASS}`,
      ) ||
      ignoreInline.indexOf(nodeName) !== -1 ||
      isNoTranslateNode(node) ||
      (node instanceof HTMLElement && node.isContentEditable) ||
      ["", "true", "plaintext-only"].includes(
        node.getAttribute("contenteditable") ?? "false",
      ) ||
      node.classList.contains("CodeMirror") ||
      node.classList.contains("material-icons") ||
      node.classList.contains("material-symbols-outlined") ||
      nodeName.startsWith("br-") ||
      node.getAttribute("id") === "branch-select-menu" ||
      (hostname === "twitter.com" &&
        nodeName === "a" &&
        (node.matches ? node.matches("article a") : true))
    );
  };

  // Mutation collection can begin below an editor/code boundary that the
  // initial document traversal rejected. Keep that same protection on re-entry.
  for (
    let owner = (root as Node).parentElement;
    owner;
    owner = owner.parentElement
  ) {
    if (skipElement(owner)) {
      includePieces = false;
      includeAttributes = false;
      break;
    }
  }

  const finishPiece = (bottomElement?: Element | null) => {
    if (!currentPiece.nodes.length) return;
    if (bottomElement !== undefined) currentPiece.bottomElement = bottomElement;
    completedPieces.push(currentPiece);
    currentPiece = emptyPiece();
    currentParagraphSize = 0;
  };

  const pieceFrames: PieceFrame[] = includePieces
    ? [
        {
          node: root as Node,
          lastHTMLElement: null,
          lastSelectOrDataListElement: null,
          stage: "enter",
          nextChild: null,
          afterBoundary: false,
          boundaryElement: null,
        },
      ]
    : [];
  let piecesDone = !includePieces;

  const pushPieceFrame = (
    node: Node,
    lastHTMLElement: Element | null,
    lastSelectOrDataListElement: Element | null,
  ) => {
    pieceFrames.push({
      node,
      lastHTMLElement,
      lastSelectOrDataListElement,
      stage: "enter",
      nextChild: null,
      afterBoundary: false,
      boundaryElement: null,
    });
  };

  const finishPieceTraversal = () => {
    if (pieceFrames.length || piecesDone) return;
    finishPiece();
    piecesDone = true;
  };

  const stepPieces = () => {
    const frame = pieceFrames[pieceFrames.length - 1];
    if (!frame) {
      finishPieceTraversal();
      return;
    }

    const { node } = frame;
    if (frame.stage === "enter") {
      if (node.nodeType === 3) {
        if ((node.textContent ?? "").trim().length > 0) {
          if (!currentPiece.parentElement) {
            if (
              node.parentNode?.nodeName.toLowerCase() === "option" &&
              frame.lastSelectOrDataListElement
            ) {
              currentPiece.parentElement = frame.lastSelectOrDataListElement;
              currentPiece.bottomElement = frame.lastSelectOrDataListElement;
              currentPiece.topElement = frame.lastSelectOrDataListElement;
            } else {
              let temp: Node | null = node.parentNode;
              const nodeName = temp?.nodeName.toLowerCase() ?? "";
              while (
                temp &&
                temp !== root &&
                (INLINE_TEXT_TAGS.indexOf(nodeName) !== -1 ||
                  INLINE_IGNORE_TAGS.indexOf(nodeName) !== -1)
              )
                temp = temp.parentNode;
              if (temp?.nodeType === 11) temp = (temp as ShadowRoot).host;
              currentPiece.parentElement = (temp as Element | null) ?? null;
            }
          }
          if (!currentPiece.topElement)
            currentPiece.topElement = frame.lastHTMLElement;
          if (currentParagraphSize > 1000) {
            const parentElement = currentPiece.parentElement;
            finishPiece(frame.lastHTMLElement);
            currentPiece.topElement = frame.lastHTMLElement;
            currentPiece.parentElement = parentElement;
          }
          currentParagraphSize += node.textContent?.length ?? 0;
          currentPiece.nodes.push(node as Text);
          currentPiece.bottomElement = null;
        }
        pieceFrames.pop();
        finishPieceTraversal();
        return;
      }

      if (node.nodeType !== 1 && node.nodeType !== 11) {
        pieceFrames.pop();
        finishPieceTraversal();
        return;
      }

      if (node.nodeType === 11) {
        frame.lastHTMLElement = (node as ShadowRoot).host;
        frame.lastSelectOrDataListElement = null;
      } else {
        frame.lastHTMLElement = node as Element;
        const nodeName = node.nodeName.toLowerCase();
        if (nodeName === "select" || nodeName === "datalist")
          frame.lastSelectOrDataListElement = node as Element;
        if (skipElement(node as Element)) {
          finishPiece(node as Element);
          pieceFrames.pop();
          finishPieceTraversal();
          return;
        }
      }
      frame.stage = "light";
      frame.nextChild = node.firstChild;
      return;
    }

    if (frame.afterBoundary) {
      finishPiece(frame.boundaryElement);
      frame.afterBoundary = false;
      frame.boundaryElement = null;
      return;
    }

    const child = frame.nextChild;
    if (child) {
      frame.nextChild = child.nextSibling;
      const nodeName = child.nodeName.toLowerCase();
      if (child.nodeType === 1) {
        frame.lastHTMLElement = child as Element;
        if (nodeName === "select" || nodeName === "datalist")
          frame.lastSelectOrDataListElement = child as Element;
      }
      if (INLINE_TEXT_TAGS.indexOf(nodeName) === -1 || isAtomicBox(child)) {
        finishPiece(frame.lastHTMLElement);
        frame.afterBoundary = true;
        frame.boundaryElement = frame.lastHTMLElement;
      }
      pushPieceFrame(
        child,
        frame.lastHTMLElement,
        frame.lastSelectOrDataListElement,
      );
      return;
    }

    if (!currentPiece.bottomElement)
      currentPiece.bottomElement = node as Element;
    if (frame.stage === "light" && (node as Element).shadowRoot) {
      frame.stage = "shadow";
      frame.nextChild = (node as Element).shadowRoot!.firstChild;
      return;
    }
    pieceFrames.pop();
    finishPieceTraversal();
  };

  const attributeGroups: TranslateAttribute[][] = [[], [], [], []];
  const rootNode = root as Node;
  const documentForRoot =
    rootNode instanceof Document
      ? rootNode
      : (rootNode.ownerDocument ?? document);
  const attributeWalker = includeAttributes
    ? documentForRoot.createTreeWalker(rootNode, 1)
    : null;
  let attributeNode: Element | null =
    includeAttributes && root instanceof Element
      ? root
      : ((attributeWalker?.nextNode() as Element | null) ?? null);
  let attributesDone = !includeAttributes;

  const pushAttribute = (
    group: number,
    node: Element,
    attribute: string,
    original: string,
  ) => {
    attributeGroups[group]!.push({
      node,
      attribute,
      original,
      isTranslated: false,
    });
  };

  const finishAttributeTraversal = () => {
    if (attributesDone) return;
    completedAttributes.push(...attributeGroups.flat());
    attributesDone = true;
  };

  const stepAttributes = () => {
    const node = attributeNode;
    if (!node) {
      finishAttributeTraversal();
      return;
    }
    let protectedAttribute = false;
    for (let owner: Element | null = node; owner; owner = owner.parentElement) {
      // Textarea values stay untouched, but their visible placeholders remain
      // eligible unless the textarea belongs to a protected editor subtree.
      if (owner === node && owner.nodeName.toLowerCase() === "textarea")
        continue;
      if (skipElement(owner)) {
        protectedAttribute = true;
        break;
      }
    }
    if (!protectedAttribute) {
      if (node.matches("input[placeholder], textarea[placeholder]")) {
        const text = node.getAttribute("placeholder");
        if (text?.trim()) pushAttribute(0, node, "placeholder", text);
      }
      if (node.matches('area[alt], img[alt], input[type="image"][alt]')) {
        const text = node.getAttribute("alt");
        if (text?.trim()) pushAttribute(1, node, "alt", text);
      }
      if (
        node.matches(
          'input[type="button"], input[type="submit"], input[type="reset"]',
        )
      ) {
        const input = node as HTMLInputElement;
        const text = input.getAttribute("value");
        if (input.type === "submit" && !text)
          pushAttribute(2, node, "value", "Submit Query");
        else if (input.type === "reset" && !text)
          pushAttribute(2, node, "value", "Reset");
        else if (text?.trim()) pushAttribute(2, node, "value", text);
      }
      if (node.matches("[title]")) {
        const text = node.getAttribute("title");
        if (text?.trim()) pushAttribute(3, node, "title", text);
      }
    }
    attributeNode = (attributeWalker?.nextNode() as Element | null) ?? null;
    if (!attributeNode) finishAttributeTraversal();
  };

  let pieceTurn = true;
  return {
    drain(budgetMs) {
      const pieces: TranslatePiece[] = [];
      const attributes: TranslateAttribute[] = [];
      const timed = Number.isFinite(budgetMs);
      const budget = Math.max(0, budgetMs);
      const startedAt = globalThis.performance?.now() ?? Date.now();
      let worked = false;

      while (!piecesDone || !attributesDone) {
        if (
          worked &&
          timed &&
          (globalThis.performance?.now() ?? Date.now()) - startedAt >= budget
        )
          break;
        if (pieceTurn && !piecesDone) stepPieces();
        else if (!attributesDone) stepAttributes();
        else stepPieces();
        pieceTurn = !pieceTurn;
        worked = true;
      }

      pieces.push(...completedPieces.splice(0));
      attributes.push(...completedAttributes.splice(0));
      return { pieces, attributes, done: piecesDone && attributesDone };
    },
  };
}

export function createTranslationCollector(
  root: ParentNode,
  hostname: string,
): TranslationCollector {
  return createCollector(root, hostname, true, true);
}

export function collectPieces(root: ParentNode, hostname: string) {
  const result = createCollector(root, hostname, true, false).drain(Infinity);
  return result.pieces;
}

export function collectAttributes(root: ParentNode): TranslateAttribute[] {
  return createCollector(root, "", false, true).drain(Infinity).attributes;
}

const PRIORITY_TAGS = new Set([
  "a",
  "button",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "input",
  "label",
  "legend",
  "nav",
  "option",
  "select",
  "summary",
  "textarea",
  "th",
]);

const PRIORITY_ROLES = new Set([
  "button",
  "checkbox",
  "columnheader",
  "combobox",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "option",
  "radio",
  "rowheader",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const BULK_TAGS = new Set(["li", "td", "tr"]);
const BULK_ROLES = new Set(["cell", "gridcell", "listitem", "row"]);

function semanticAncestors(element: Element | null) {
  const ancestors: Element[] = [];
  let current = element;
  while (current) {
    ancestors.push(current);
    const root = current.getRootNode();
    current =
      current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return ancestors;
}

export function translationLane(
  record: TranslatePiece | TranslateAttribute,
): TranslationLane {
  const element =
    "node" in record
      ? record.node
      : (record.nodes[0]?.parentElement ??
        record.topElement ??
        record.parentElement);
  const ancestors = semanticAncestors(element);
  const roles = ancestors.flatMap((item) =>
    (item.getAttribute("role") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  if (
    ancestors.some((item) => PRIORITY_TAGS.has(item.nodeName.toLowerCase())) ||
    roles.some((role) => PRIORITY_ROLES.has(role))
  )
    return "priority";
  if (
    ancestors.some((item) => BULK_TAGS.has(item.nodeName.toLowerCase())) ||
    roles.some((role) => BULK_ROLES.has(role))
  )
    return "bulk";
  return "priority";
}

function isRenderedElement(element: Element | null) {
  if (!element?.isConnected) return false;
  const style = getComputedStyle(element);
  if (
    style.visibility !== "visible" ||
    style.display === "none" ||
    style.contentVisibility === "hidden"
  )
    return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function intersectsViewport(
  element: Element | null,
  innerHeight: number,
  innerWidth: number,
  verticalMargin = 0,
  horizontalMargin = 0,
) {
  if (!isRenderedElement(element)) return false;
  const rect = element!.getBoundingClientRect();
  return (
    rect.bottom > -verticalMargin &&
    rect.top < innerHeight + verticalMargin &&
    rect.right > -horizontalMargin &&
    rect.left < innerWidth + horizontalMargin
  );
}

function noBoxTextIsInViewport(
  node: Text,
  innerHeight: number,
  innerWidth: number,
  verticalMargin: number,
  horizontalMargin: number,
) {
  const root = node.getRootNode();
  const element =
    node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  if (
    !element?.isConnected ||
    (node.parentElement && getComputedStyle(element).display !== "contents")
  )
    return false;
  for (const owner of semanticAncestors(element)) {
    const style = getComputedStyle(owner);
    if (
      style.visibility !== "visible" ||
      style.display === "none" ||
      style.contentVisibility === "hidden"
    )
      return false;
  }
  try {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > -verticalMargin &&
      rect.top < innerHeight + verticalMargin &&
      rect.right > -horizontalMargin &&
      rect.left < innerWidth + horizontalMargin
    );
  } catch {
    return false;
  }
}

export function pieceIsInViewport(
  piece: TranslatePiece,
  innerHeight: number,
  innerWidth: number,
  verticalMargin = 0,
  horizontalMargin = 0,
) {
  return (
    (piece.nodes.some((node) => {
      if (isRenderedElement(node.parentElement)) return true;
      const option = node.parentElement;
      const owner = piece.parentElement;
      // Native option labels have no DOM box. Use only the select ownership
      // established by collection, without exposing arbitrary hidden text.
      if (
        option?.nodeName !== "OPTION" ||
        !(owner instanceof HTMLSelectElement) ||
        option.closest("select") !== owner
      )
        return false;
      const style = getComputedStyle(option);
      return (
        style.visibility === "visible" &&
        style.display !== "none" &&
        !option.hasAttribute("hidden") &&
        isRenderedElement(owner)
      );
    }) &&
      (intersectsViewport(
        piece.topElement,
        innerHeight,
        innerWidth,
        verticalMargin,
        horizontalMargin,
      ) ||
        intersectsViewport(
          piece.bottomElement,
          innerHeight,
          innerWidth,
          verticalMargin,
          horizontalMargin,
        ))) ||
    piece.nodes.some((node) =>
      noBoxTextIsInViewport(
        node,
        innerHeight,
        innerWidth,
        verticalMargin,
        horizontalMargin,
      ),
    )
  );
}

export function attributeIsInViewport(
  element: Element,
  innerHeight: number,
  innerWidth: number,
  verticalMargin = 0,
  horizontalMargin = 0,
) {
  return intersectsViewport(
    element,
    innerHeight,
    innerWidth,
    verticalMargin,
    horizontalMargin,
  );
}
