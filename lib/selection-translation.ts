import type { TargetLanguage } from "@/lib/translation";
import {
  SelectionTranslationPanel,
  type SelectionTranslationView,
} from "@/components/SelectionTranslationPanel";
import { readEligibleSelection } from "@/lib/selection-eligibility";
import type { UiLocale } from "@/lib/i18n/core";
import {
  browserUiLanguage,
  requestUiLocale,
  resolveUiLocale,
} from "@/lib/i18n/locale";
import { UiLocaleScope } from "@/lib/i18n/react";
import {
  selectionMessages,
  type SelectionMessage,
} from "@/lib/i18n/catalog/selection";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { ContentScriptContext } from "wxt/utils/content-script-context";

export interface SelectionTranslationRequest {
  type: "TRANSLATE_SELECTION";
  requestId: number;
  text: string;
  targetLanguage: TargetLanguage;
}

export interface SelectionTranslationUiLoadRequest {
  type: "LOAD_SELECTION_TRANSLATION_UI";
}

export interface SelectionTranslationUiLoadResponse {
  loaded: boolean;
}

export type SelectionTranslationResponse =
  | { requestId: number; text: string }
  | {
      requestId: number;
      error:
        | "invalid-request"
        | "too-long"
        | "auth-required"
        | "auth-unavailable"
        /** Free without the on-device Translator (Chrome 138+ desktop). */
        | "on-device-unavailable"
        | "translation-failed";
    };

interface Snapshot {
  key: string;
  range: Range;
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">;
  text: string;
}
type ErrorCode = Extract<
  SelectionTranslationResponse,
  { error: string }
>["error"];

const nodeIds = new WeakMap<Node, number>();
let nextNodeId = 1;

function nodeId(node: Node) {
  let id = nodeIds.get(node);
  if (!id) nodeIds.set(node, (id = nextNodeId++));
  return id;
}

function readSelection(): Snapshot | null {
  const eligible = readEligibleSelection();
  if (!eligible) return null;
  const { range, selection, text } = eligible;
  const rects = Array.from(range.getClientRects());
  const focusIsStart =
    selection.focusNode === range.startContainer &&
    selection.focusOffset === range.startOffset;
  const rect =
    (focusIsStart ? rects[0] : rects.at(-1)) ?? range.getBoundingClientRect();
  return {
    key: `${nodeId(range.startContainer)}:${range.startOffset}-${nodeId(range.endContainer)}:${range.endOffset}:${text}`,
    range: range.cloneRange(),
    rect: {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    },
    text,
  };
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

export function mountSelectionTranslation(
  container: HTMLElement,
  portalContainer: ShadowRoot,
  ctx: ContentScriptContext,
): () => void {
  let ready = false;
  let targetLanguage: TargetLanguage = "en";
  let snapshot: Snapshot | null = null;
  let dismissedKey: string | null = null;
  let view: SelectionTranslationView = "hidden";
  let generation = 0;
  let nextRequestId = 0;
  let resultText = "";
  let message: SelectionMessage | "" = "";
  let messageIsError = false;
  // The UI locale comes from the background (it alone reads the extension
  // IndexedDB), on mount and again on every open.
  let locale: UiLocale = resolveUiLocale(undefined, browserUiLanguage());
  const refreshLocale = () =>
    requestUiLocale().then(
      (current) => {
        if (cleaned || current === locale) return;
        locale = current;
        if (view !== "hidden") render();
      },
      () => undefined,
    );
  let pending: { id: number; timedOut: boolean; timer: number } | undefined;
  let selectionReadTimer: number | undefined;
  let selectionReadPromise: Promise<void> | undefined;
  let resolveSelectionRead: (() => void) | undefined;
  let cleaned = false;
  const reactRoot = createRoot(container);

  const removers: (() => void)[] = [];
  const listen = (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ) => {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const shadowHost = portalContainer.host;
  const fromUi = (event: Event) =>
    container.contains(event.target as Node) ||
    event.composedPath().includes(container) ||
    (shadowHost !== null && event.composedPath().includes(shadowHost));

  function position(nextView: "icon" | "panel") {
    if (!snapshot) return;
    const root = container.querySelector<HTMLElement>(
      '[data-role="selection-root"]',
    );
    const panel = container.querySelector<HTMLElement>(
      '[data-role="selection-panel"]',
    );
    if (!root || !panel) return;
    // Layout size: the panel pops in with a transform, which a bounding
    // rect would include.
    const panelRect = panel.getBoundingClientRect();
    const width =
      nextView === "icon"
        ? 32
        : panel.offsetWidth ||
          panelRect.width ||
          Math.min(360, window.innerWidth - 16);
    const height =
      nextView === "icon" ? 32 : panel.offsetHeight || panelRect.height || 240;
    let left = snapshot.rect.right + 8;
    let top = snapshot.rect.bottom + 8;
    if (left + width > window.innerWidth - 8)
      left = snapshot.rect.left - width - 8;
    if (top + height > window.innerHeight - 8)
      top = snapshot.rect.top - height - 8;
    // The panel grows from the corner nearest its anchor.
    root.style.setProperty(
      "--readlace-origin",
      `${top < snapshot.rect.top ? "bottom" : "top"} ${left < snapshot.rect.left ? "right" : "left"}`,
    );
    root.style.left = `${clamp(left, 8, window.innerWidth - width - 8)}px`;
    root.style.top = `${clamp(top, 8, window.innerHeight - height - 8)}px`;
  }

  function render() {
    if (cleaned || !ready) return;
    const panel = createElement(SelectionTranslationPanel, {
      busy: Boolean(pending),
      error: messageIsError,
      iconUrl: browser.runtime.getURL("/icon/32.png"),
      message: message
        ? selectionMessages.translator(locale).text(message)
        : "",
      onClose: collapseToIcon,
      onOpen: () => {
        if (!snapshot) return;
        show("panel");
        container
          .querySelector<HTMLElement>(
            '[data-role="target-field"] [role="combobox"]',
          )
          ?.focus();
        void refreshLocale();
      },
      onTargetChange: (nextTarget) => {
        if (pending || targetLanguage === nextTarget) return;
        targetLanguage = nextTarget;
        invalidateResult();
        render();
      },
      onTranslate: () => void requestTranslation(),
      portalContainer,
      result: resultText,
      target: targetLanguage,
      timedOut: pending?.timedOut ?? false,
      view,
    });
    flushSync(() =>
      reactRoot.render(
        createElement(UiLocaleScope, { locale, children: panel }),
      ),
    );
    if (view !== "hidden") position(view);
  }

  function show(nextView: "hidden" | "icon" | "panel") {
    view = nextView;
    render();
  }

  function invalidateResult() {
    generation++;
    resultText = "";
    message = "";
    messageIsError = false;
  }

  function cancelSelectionRead() {
    if (selectionReadTimer !== undefined)
      window.clearTimeout(selectionReadTimer);
    selectionReadTimer = undefined;
    selectionReadPromise = undefined;
    resolveSelectionRead?.();
    resolveSelectionRead = undefined;
  }

  function scheduleSelectionRead() {
    if (selectionReadTimer !== undefined) return;
    selectionReadPromise = new Promise((resolve) => {
      resolveSelectionRead = resolve;
    });
    selectionReadTimer = window.setTimeout(() => {
      selectionReadTimer = undefined;
      try {
        refreshSelection();
      } finally {
        selectionReadPromise = undefined;
        resolveSelectionRead?.();
        resolveSelectionRead = undefined;
      }
    });
  }

  function dismiss() {
    cancelSelectionRead();
    dismissedKey = snapshot?.key ?? dismissedKey;
    snapshot = null;
    invalidateResult();
    show("hidden");
  }

  function collapseToIcon() {
    cancelSelectionRead();
    const next = readSelection();
    if (!next) {
      dismiss();
      return;
    }
    if (next.key !== snapshot?.key) invalidateResult();
    snapshot = next;
    dismissedKey = null;
    show("icon");
  }

  function refreshSelection() {
    const next = readSelection();
    if (!next) {
      if (view !== "hidden") dismiss();
      return;
    }
    if (next.key === dismissedKey || next.key === snapshot?.key) return;
    snapshot = next;
    dismissedKey = null;
    invalidateResult();
    show("icon");
  }

  /** JSON error codes map to messages here, at the UI edge. */
  const errorMessage = (error: ErrorCode): SelectionMessage => {
    if (error === "auth-required") return "selection.error.authRequired";
    if (error === "auth-unavailable") return "session.unavailable";
    if (error === "too-long") return "selection.error.tooLong";
    if (error === "on-device-unavailable") return "notice.onDeviceUnsupported";
    if (error === "invalid-request") return "selection.error.invalid";
    return "selection.error.failed";
  };

  async function requestTranslation() {
    if (!ready || !snapshot || pending) return;
    if (
      !snapshot.range.startContainer.isConnected ||
      !snapshot.range.endContainer.isConnected
    ) {
      dismiss();
      return;
    }
    const activeSnapshot = snapshot;
    const activeGeneration = generation;
    const activeTargetLanguage = targetLanguage;
    const id = nextRequestId++;
    const timer = window.setTimeout(() => {
      if (!pending || pending.id !== id) return;
      pending.timedOut = true;
      if (view === "panel") render();
    }, 45_000);
    pending = { id, timedOut: false, timer };
    render();

    let response: SelectionTranslationResponse;
    try {
      response = (await browser.runtime.sendMessage({
        type: "TRANSLATE_SELECTION",
        requestId: id,
        text: activeSnapshot.text,
        targetLanguage: activeTargetLanguage,
      } satisfies SelectionTranslationRequest)) as SelectionTranslationResponse;
    } catch {
      response = { requestId: id, error: "translation-failed" };
    }
    const scheduledSelectionRead = selectionReadPromise;
    if (scheduledSelectionRead) await scheduledSelectionRead;
    if (!pending || pending.id !== id) return;
    window.clearTimeout(pending.timer);
    const timedOut = pending.timedOut;
    pending = undefined;
    if (
      cleaned ||
      timedOut ||
      generation !== activeGeneration ||
      response.requestId !== id
    ) {
      if (!cleaned && view === "panel") render();
      return;
    }
    if ("text" in response) {
      resultText = response.text;
      message = "";
      messageIsError = false;
    } else {
      resultText = "";
      message = errorMessage(response.error);
      messageIsError = true;
    }
    if (view === "panel") render();
  }

  for (const type of ["pointerdown", "pointerup", "keyup"]) {
    listen(container, type, (event) => event.stopPropagation());
  }
  listen(container, "transitionend", (rawEvent) => {
    const event = rawEvent as TransitionEvent;
    if (
      view === "panel" &&
      event.propertyName === "grid-template-rows" &&
      event.target instanceof Element &&
      event.target.classList.contains("readlace-selection__result-group")
    )
      position("panel");
  });
  listen(container, "keydown", (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (view === "panel" && snapshot) {
      collapseToIcon();
      container
        .querySelector<HTMLElement>('[data-role="selection-trigger"]')
        ?.focus();
    } else dismiss();
  });
  listen(document, "pointerdown", (event) => {
    if (fromUi(event)) return;
    if (view === "panel") collapseToIcon();
    else dismissedKey = null;
  });
  listen(
    document,
    "pointerup",
    (event) => {
      if (!fromUi(event)) scheduleSelectionRead();
    },
    true,
  );
  listen(
    document,
    "dblclick",
    (event) => {
      if (!fromUi(event)) scheduleSelectionRead();
    },
    true,
  );
  listen(
    document,
    "keyup",
    (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (fromUi(event)) return;
      if (event.key === "Escape") dismiss();
      else scheduleSelectionRead();
    },
    true,
  );
  listen(
    document,
    "scroll",
    (event) => {
      if (!fromUi(event) && view !== "hidden") collapseToIcon();
    },
    true,
  );
  listen(window, "resize", () => {
    if (view !== "hidden") collapseToIcon();
  });
  listen(window, "pagehide", (event) => {
    if (!(event as PageTransitionEvent).persisted) cleanup();
  });

  const handleAuthStateChanged = (event: unknown) => {
    if ((event as { type?: string } | undefined)?.type !== "AUTH_STATE_CHANGED")
      return;
    generation++;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pending = undefined;
    message = "session.changed";
    messageIsError = true;
    render();
  };
  browser.runtime.onMessage.addListener(handleAuthStateChanged);
  removers.push(() =>
    browser.runtime.onMessage.removeListener(handleAuthStateChanged),
  );
  const stopInvalidation = ctx.onInvalidated(() => cleanup());
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    removers.splice(0).forEach((remove) => remove());
    cancelSelectionRead();
    if (pending) window.clearTimeout(pending.timer);
    pending = undefined;
    stopInvalidation();
    reactRoot.unmount();
  }

  void Promise.resolve().then(() => {
    if (cleaned) return;
    ready = true;
    render();
    refreshSelection();
    void refreshLocale();
  });
  return cleanup;
}
