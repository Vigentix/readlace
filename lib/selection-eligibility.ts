export interface EligibleSelection {
  range: Range;
  selection: Selection;
  text: string;
}

function hasEditableAncestor(node: Node) {
  let element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  while (element) {
    if (element.matches("input, textarea")) return true;
    const editable = element.getAttribute("contenteditable");
    if (editable !== null) return editable.toLowerCase() !== "false";
    element = element.parentElement;
  }
  return false;
}

function touchesEditable(range: Range) {
  if (
    hasEditableAncestor(range.startContainer) ||
    hasEditableAncestor(range.endContainer)
  ) {
    return true;
  }
  try {
    const root = range.commonAncestorContainer;
    const selectedEditableText =
      root.nodeType === Node.TEXT_NODE
        ? hasEditableAncestor(root)
        : Boolean(
            document
              .createTreeWalker(
                root,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
                {
                  acceptNode(node) {
                    if (!range.intersectsNode(node))
                      return NodeFilter.FILTER_REJECT;
                    if (node.nodeType === Node.ELEMENT_NODE)
                      return NodeFilter.FILTER_SKIP;
                    const text = node as Text;
                    const start =
                      text === range.startContainer ? range.startOffset : 0;
                    const end =
                      text === range.endContainer
                        ? range.endOffset
                        : text.length;
                    return start < end && hasEditableAncestor(text)
                      ? NodeFilter.FILTER_ACCEPT
                      : NodeFilter.FILTER_SKIP;
                  },
                },
              )
              .nextNode(),
          );
    return (
      selectedEditableText ||
      [
        ...range
          .cloneContents()
          .querySelectorAll("input, textarea, [contenteditable]"),
      ].some(
        (element) =>
          element.matches("input, textarea") ||
          element.getAttribute("contenteditable")?.toLowerCase() !== "false",
      )
    );
  } catch {
    return true;
  }
}

export function readEligibleSelection(): EligibleSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  if (
    range.startContainer.getRootNode() !== document ||
    range.endContainer.getRootNode() !== document ||
    touchesEditable(range)
  ) {
    return null;
  }
  const text = range.toString();
  return text.trim() ? { range, selection, text } : null;
}
