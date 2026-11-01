import { fireEvent, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";

import selectionContent from "@/entrypoints/selection.content";
import selectionUiContent from "@/entrypoints/selection-ui.content";
import { readEligibleSelection } from "./selection-eligibility";
import { mountSelectionTranslation } from "./selection-translation";

vi.mock("wxt/utils/content-script-ui/shadow-root", () => ({
  createShadowRootUi: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function select(node: Text, start = 0, end = node.length) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function transition(type: "pagehide" | "pageshow", persisted: boolean) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

const settleSelectionRead = () =>
  new Promise<void>((resolve) => window.setTimeout(resolve));

async function setup() {
  const host = document.createElement("readlace-selection-translator");
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  document.body.append(host);
  const ctx = new ContentScriptContext("selection-test", {
    noScriptStartedPostMessage: true,
  });
  const cleanup = mountSelectionTranslation(container, shadow, ctx);
  await vi.waitFor(() => expect(getIcon(container)).toBeInTheDocument());
  return { container, ctx, cleanup, shadow };
}

const getIcon = (container: HTMLElement) =>
  container.querySelector(
    '[aria-label="Translate selected text"]',
  ) as HTMLButtonElement;

function open(container: HTMLElement) {
  fireEvent.click(getIcon(container));
  return {
    get close() {
      return container.querySelector(
        '[aria-label="Close selection translator"]',
      ) as HTMLButtonElement;
    },
    get dialog() {
      return container.querySelector('[role="dialog"]') as HTMLElement;
    },
    get result() {
      return container.querySelector(
        '[aria-label="Translation result"]',
      ) as HTMLElement;
    },
    get provider() {
      return container.querySelector(
        '[role="combobox"][aria-label="Provider"]',
      ) as HTMLButtonElement | null;
    },
    get target() {
      return container.querySelector(
        '[role="combobox"][aria-label="Translate to"]',
      ) as HTMLButtonElement;
    },
    get status() {
      return container.querySelector(
        '[data-role="selection-status"]',
      ) as HTMLElement;
    },
    get translate() {
      return container.querySelector(
        ".readlace-selection__translate",
      ) as HTMLButtonElement;
    },
  };
}

async function choose(
  shadow: ShadowRoot,
  control: HTMLButtonElement,
  option: string,
) {
  const user = userEvent.setup();
  await user.click(control);
  await user.click(
    await within(shadow as unknown as HTMLElement).findByRole("option", {
      name: option,
    }),
  );
}

const translationMessages = () =>
  vi
    .mocked(fakeBrowser.runtime.sendMessage)
    .mock.calls.map(([message]) => message as unknown as { type?: string })
    .filter((message) => message.type === "TRANSLATE_SELECTION");

describe("selection translation controller", () => {
  beforeEach(() => {
    vi.useRealTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1024 },
      innerHeight: { configurable: true, value: 768 },
    });
    Object.defineProperties(Range.prototype, {
      getClientRects: {
        configurable: true,
        value: () => [{ left: 20, right: 120, top: 30, bottom: 50 }],
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 20, right: 120, top: 30, bottom: 50 }),
      },
    });
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
      async (message) => {
        const request = message as unknown as {
          type?: string;
          requestId?: number;
        };
        return (
          request.type === "GET_SELECTION_TRANSLATION_CONTEXT"
            ? { provider: "google" }
            : { requestId: request.requestId, text: "Translated" }
        ) as never;
      },
    );
    (
      globalThis as typeof globalThis & {
        __readlaceSelectionTranslationUi?: boolean;
      }
    ).__readlaceSelectionTranslationUi = undefined;
  });

  it("captures exact page text and sends only after Translate", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Japanese page translated to English";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text, 28, 35);
    const original = paragraph.outerHTML;
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    send.mockImplementation(async (message) => {
      const request = message as unknown as {
        type: string;
        requestId?: number;
      };
      return (
        request.type === "GET_SELECTION_TRANSLATION_CONTEXT"
          ? { provider: "google" }
          : { requestId: request.requestId, text: "tiếng Anh" }
      ) as never;
    });
    const { container, shadow } = await setup();

    expect(getIcon(container)).toBeVisible();
    const panel = open(container);
    expect(panel.status).toBeNull();
    await choose(shadow, panel.target, "Vietnamese");
    expect(translationMessages()).toHaveLength(0);
    fireEvent.click(panel.translate);
    await vi.waitFor(() => expect(panel.result).toHaveTextContent("tiếng Anh"));
    expect(panel.status).toBeNull();

    expect(send).toHaveBeenCalledWith({
      type: "TRANSLATE_SELECTION",
      requestId: 0,
      text: "English",
      targetLanguage: "vi",
    });
    expect(paragraph.outerHTML).toBe(original);
    expect(
      container.querySelector("#readlace-selection-title"),
    ).toHaveTextContent(/^Readlace$/);
  });

  it("exposes no provider choice and keeps the target document-local", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Target isolation";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const response = deferred<{ requestId: number; text: string }>();
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    send.mockImplementation(() => response.promise as never);
    const storageWrite = vi.spyOn(fakeBrowser.storage.local, "set");
    const { container, shadow } = await setup();
    const panel = open(container);
    expect(panel.provider).toBeNull();

    await choose(shadow, panel.target, "Vietnamese");
    expect(translationMessages()).toHaveLength(0);
    fireEvent.click(panel.translate);

    expect(translationMessages()).toEqual([
      {
        type: "TRANSLATE_SELECTION",
        requestId: 0,
        targetLanguage: "vi",
        text: "Target isolation",
      },
    ]);
    expect(
      send.mock.calls.some(
        ([message]) =>
          (message as unknown as { type?: string }).type ===
          "GET_SELECTION_TRANSLATION_CONTEXT",
      ),
    ).toBe(false);
    expect(panel.target).toBeDisabled();
    expect(storageWrite).not.toHaveBeenCalled();
    response.resolve({ requestId: 0, text: "Isolated" });
  });

  it("anchors to the focus-side fragment for forward and backward selection", async () => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [
        { left: 10, right: 20, top: 10, bottom: 20 },
        { left: 100, right: 120, top: 40, bottom: 50 },
      ],
    });
    const paragraph = document.createElement("p");
    paragraph.textContent = "Two fragments";
    document.body.append(paragraph);
    const text = paragraph.firstChild as Text;
    select(text);
    const forward = await setup();
    expect(
      (forward.container.firstElementChild as HTMLElement).style.left,
    ).toBe("128px");
    forward.cleanup();

    window.getSelection()!.setBaseAndExtent(text, text.length, text, 0);
    const backward = await setup();
    expect(
      (backward.container.firstElementChild as HTMLElement).style.left,
    ).toBe("28px");
  });

  it("observes pointer and keyboard selections before page handlers stop propagation", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Facebook post text";
    document.body.append(paragraph);
    const pointerController = await setup();
    paragraph.addEventListener("pointerup", (event) => event.stopPropagation());
    select(paragraph.firstChild as Text, 0, 8);
    fireEvent.pointerUp(paragraph);
    await settleSelectionRead();
    expect(getIcon(pointerController.container)).toBeVisible();
    pointerController.cleanup();

    window.getSelection()!.removeAllRanges();
    const keyboardController = await setup();
    paragraph.addEventListener("keyup", (event) => event.stopPropagation());
    select(paragraph.firstChild as Text, 9, 13);
    fireEvent.keyUp(paragraph, { key: "Shift" });
    await settleSelectionRead();
    expect(getIcon(keyboardController.container)).toBeVisible();
  });

  it("reads double-click selection after page behavior without blocking the page", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Double click selection";
    document.body.append(paragraph);
    window.getSelection()!.removeAllRanges();
    const controller = await setup();
    vi.useFakeTimers();
    let pageEvent: { cancelled: boolean; prevented: boolean } | undefined;
    paragraph.addEventListener("dblclick", (event) => {
      pageEvent = {
        cancelled: event.cancelBubble,
        prevented: event.defaultPrevented,
      };
      select(paragraph.firstChild as Text, 0, 6);
    });
    fireEvent.doubleClick(paragraph);
    expect(pageEvent).toEqual({ cancelled: false, prevented: false });
    expect(window.getSelection()?.toString()).toBe("Double");
    expect(readEligibleSelection()?.text).toBe("Double");
    expect(getIcon(controller.container)).not.toBeVisible();
    vi.runOnlyPendingTimers();
    expect(
      controller.container.querySelector('[data-role="selection-root"]'),
    ).not.toHaveAttribute("hidden");
    expect(getIcon(controller.container)).not.toHaveAttribute("hidden");
  });

  it("reclamps the panel after translated content changes its height", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 360,
    });
    Object.defineProperties(Range.prototype, {
      getClientRects: {
        configurable: true,
        value: () => [{ left: 20, right: 120, top: 330, bottom: 350 }],
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 20, right: 120, top: 330, bottom: 350 }),
      },
    });
    const paragraph = document.createElement("p");
    paragraph.textContent = "Near edge";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      async (message) => {
        const request = message as unknown as {
          type: string;
          requestId?: number;
        };
        return (
          request.type === "GET_SELECTION_TRANSLATION_CONTEXT"
            ? { provider: "google" }
            : {
                requestId: request.requestId,
                text: "Long translated result",
              }
        ) as never;
      },
    );
    const { container } = await setup();
    const controls = open(container);
    const panel = container.querySelector(
      ".readlace-selection__panel",
    ) as HTMLElement;
    vi.spyOn(panel, "getBoundingClientRect")
      .mockReturnValueOnce({ width: 340, height: 100 } as DOMRect)
      .mockReturnValue({ width: 340, height: 300 } as DOMRect);

    fireEvent.click(controls.translate);
    await vi.waitFor(() =>
      expect(controls.result).toHaveTextContent("Long translated result"),
    );
    expect((container.firstElementChild as HTMLElement).style.top).toBe("22px");
  });

  it("rejects empty, multi-range, editable, and editable-intersecting ranges", async () => {
    const text = document.createElement("p");
    text.textContent = "Readable";
    const editor = document.createElement("span");
    editor.setAttribute("contenteditable", "true");
    editor.textContent = "Editor";
    document.body.append(text, editor);
    const { container } = await setup();
    expect(getIcon(container)).not.toBeVisible();

    select(editor.firstChild as Text);
    fireEvent.pointerUp(document);
    expect(getIcon(container)).not.toBeVisible();

    const crossing = document.createRange();
    crossing.setStart(text.firstChild as Text, 0);
    crossing.setEnd(editor.firstChild as Text, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(crossing);
    fireEvent.pointerUp(document);
    expect(getIcon(container)).not.toBeVisible();

    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 2,
    } as Selection);
    fireEvent.pointerUp(document);
    await settleSelectionRead();
    expect(getIcon(container)).not.toBeVisible();
  });

  it("rejects editable text between contenteditable=false islands", async () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.innerHTML =
      '<span contenteditable="false">Safe one</span> editable <span contenteditable="false">Safe two</span>';
    document.body.append(editor);
    const first = editor.firstElementChild!.firstChild as Text;
    const middle = editor.childNodes[1] as Text;
    const last = editor.lastElementChild!.firstChild as Text;
    const crossing = document.createRange();
    crossing.setStart(first, 0);
    crossing.setEnd(last, last.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(crossing);
    const { container, shadow } = await setup();
    expect(getIcon(container)).not.toBeVisible();
    expect(translationMessages()).toHaveLength(0);

    expect(middle.data).toContain("editable");
    select(first);
    fireEvent.pointerUp(first.parentElement!);
    await settleSelectionRead();
    expect(
      container.querySelector('[data-role="selection-root"]'),
    ).not.toHaveAttribute("hidden");
    expect(container.getRootNode()).toBe(shadow);
    expect(getIcon(container)).not.toHaveAttribute("hidden");
    expect(translationMessages()).toHaveLength(0);
  });

  it("keeps the snapshot after panel focus collapses native selection", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Captured text";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    send.mockImplementation(async (message) => {
      const request = message as unknown as {
        type: string;
        requestId?: number;
      };
      return (
        request.type === "GET_SELECTION_TRANSLATION_CONTEXT"
          ? { provider: "google" }
          : { requestId: request.requestId, text: "Captured" }
      ) as never;
    });
    const { container } = await setup();
    const panel = open(container);
    window.getSelection()!.removeAllRanges();

    fireEvent.click(panel.translate);
    await vi.waitFor(() => expect(translationMessages()).toHaveLength(1));
    expect(translationMessages()[0]).toMatchObject({ text: "Captured text" });
  });

  it("allows one pending request and ignores its result after a new selection", async () => {
    const paragraph = document.createElement("p");
    paragraph.append(
      document.createTextNode("First"),
      document.createTextNode("Second"),
    );
    document.body.append(paragraph);
    paragraph.addEventListener("pointerup", (event) => event.stopPropagation());
    select(paragraph.firstChild as Text);
    const first = deferred<{ requestId: number; text: string }>();
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    let requestCount = 0;
    send.mockImplementation((message) => {
      const request = message as unknown as { type: string };
      if (request.type === "GET_SELECTION_TRANSLATION_CONTEXT")
        return Promise.resolve({ provider: "google" }) as never;
      // The panel asks the background for the UI locale on mount and open.
      if (request.type === "UI_LOCALE_GET")
        return Promise.resolve(undefined) as never;
      return (
        requestCount++ === 0
          ? first.promise
          : Promise.resolve({ requestId: 1, text: "Deuxième" })
      ) as never;
    });
    const { container } = await setup();
    let panel = open(container);
    fireEvent.click(panel.translate);
    fireEvent.click(panel.translate);
    expect(translationMessages()).toHaveLength(1);

    select(paragraph.lastChild as Text);
    fireEvent.pointerUp(document);
    await settleSelectionRead();
    first.resolve({ requestId: 0, text: "Premier" });
    await Promise.resolve();
    await Promise.resolve();
    panel = open(container);
    expect(panel.result).toBeEmptyDOMElement();
    fireEvent.click(panel.translate);
    await vi.waitFor(() => expect(panel.result).toHaveTextContent("Deuxième"));
  });

  it("keeps a pending result when an external keyup leaves selection unchanged", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Unchanged selection";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const response = deferred<{ requestId: number; text: string }>();
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      (message) =>
        ((message as unknown as { type: string }).type ===
        "GET_SELECTION_TRANSLATION_CONTEXT"
          ? Promise.resolve({ provider: "google" })
          : response.promise) as never,
    );
    const { container } = await setup();
    const panel = open(container);
    fireEvent.click(panel.translate);

    fireEvent.keyUp(paragraph, { key: "Shift" });
    response.resolve({ requestId: 0, text: "Preserved result" });

    await vi.waitFor(() =>
      expect(panel.result).toHaveTextContent("Preserved result"),
    );
    expect(translationMessages()).toHaveLength(1);
  });

  it("keeps a watchdog-timed-out request locked until it settles", async () => {
    vi.useFakeTimers();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Slow";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const response = deferred<{ requestId: number; text: string }>();
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      (message) =>
        ((message as unknown as { type: string }).type ===
        "GET_SELECTION_TRANSLATION_CONTEXT"
          ? Promise.resolve({ provider: "google" })
          : response.promise) as never,
    );
    const { container } = await setup();
    const panel = open(container);
    fireEvent.click(panel.translate);
    vi.advanceTimersByTime(45_000);
    expect(panel.status).toHaveTextContent("taking longer than expected");
    expect(panel.translate).toBeDisabled();

    response.resolve({ requestId: 0, text: "Late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.result).toBeEmptyDOMElement();
    expect(panel.translate).not.toBeDisabled();
  });

  it("keeps a request pending and the icon available across close and page scroll", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Still pending";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const response = deferred<{ requestId: number; text: string }>();
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      (message) =>
        ((message as unknown as { type: string }).type ===
        "GET_SELECTION_TRANSLATION_CONTEXT"
          ? Promise.resolve({ provider: "google" })
          : response.promise) as never,
    );
    const { container } = await setup();
    let panel = open(container);
    fireEvent.click(panel.translate);
    fireEvent.click(panel.close);
    expect(getIcon(container)).toBeVisible();
    panel = open(container);
    expect(panel.translate).toBeDisabled();
    fireEvent.scroll(panel.dialog);
    expect(panel.dialog).not.toHaveAttribute("hidden");
    fireEvent.scroll(document.body);
    expect(panel.dialog).toHaveAttribute("hidden");
    expect(getIcon(container)).toBeVisible();
    panel = open(container);
    expect(panel.translate).toBeDisabled();
    response.resolve({ requestId: 0, text: "Late" });
  });

  it("renders provider output as text and exposes auth-required", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Unsafe";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    let requestCount = 0;
    send.mockImplementation(async (message) => {
      const request = message as unknown as { type: string };
      if (request.type === "GET_SELECTION_TRANSLATION_CONTEXT")
        return { provider: "google" } as never;
      // The panel asks the background for the UI locale on mount and open.
      if (request.type === "UI_LOCALE_GET") return undefined as never;
      return (
        requestCount++ === 0
          ? { requestId: 0, text: "<img src=x>" }
          : { requestId: 1, error: "auth-required" }
      ) as never;
    });
    const { container, shadow } = await setup();
    let panel = open(container);
    fireEvent.click(panel.translate);
    await vi.waitFor(() => expect(panel.result).toHaveTextContent("<img"));
    expect(panel.result.querySelector("img")).toBeNull();
    fireEvent.click(panel.close);
    expect(getIcon(container)).toBeVisible();
    panel = open(container);
    expect(panel.result).toHaveTextContent("<img");
    await choose(shadow, panel.target, "Japanese");
    fireEvent.click(panel.translate);
    await vi.waitFor(() =>
      expect(panel.status).toHaveTextContent("toolbar popup"),
    );
  });

  it("shows auth-unavailable without asking the user to sign in", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Temporary auth failure";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      async (message) => {
        const request = message as unknown as {
          type: string;
          requestId?: number;
        };
        return (
          request.type === "GET_SELECTION_TRANSLATION_CONTEXT"
            ? { provider: "google" }
            : { requestId: request.requestId, error: "auth-unavailable" }
        ) as never;
      },
    );
    const { container } = await setup();
    const panel = open(container);
    fireEvent.click(panel.translate);
    await vi.waitFor(() =>
      expect(panel.status).toHaveTextContent(
        "Cannot verify your session. Try again.",
      ),
    );
    expect(panel.status).not.toHaveTextContent("Sign in");
    expect(panel.translate).toBeEnabled();
  });

  it("retires pending work across invalidation and same-user relogin while preserving accepted output", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Same account, different session";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const oldResponse = deferred<unknown>();
    const newResponse = deferred<unknown>();
    let requestCount = 0;
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      async (message) => {
        const request = message as unknown as { type: string };
        if (request.type === "GET_SELECTION_TRANSLATION_CONTEXT")
          return { provider: "google" } as never;
        return (
          requestCount++ === 0 ? oldResponse.promise : newResponse.promise
        ) as never;
      },
    );
    const { container, cleanup } = await setup();
    const panel = open(container);
    fireEvent.click(panel.translate);
    expect(panel.translate).toBeDisabled();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "AUTH_STATE_CHANGED" },
      {},
      vi.fn(),
    );
    expect(panel.translate).toBeEnabled();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "AUTH_STATE_CHANGED" },
      {},
      vi.fn(),
    );
    fireEvent.click(panel.translate);
    oldResponse.resolve({ requestId: 0, text: "Old session result" });
    await settleSelectionRead();
    expect(panel.translate).toBeDisabled();
    expect(panel.result).not.toHaveTextContent("Old session result");
    newResponse.resolve({ requestId: 1, text: "New session result" });
    await vi.waitFor(() =>
      expect(panel.result).toHaveTextContent("New session result"),
    );
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "AUTH_STATE_CHANGED" },
      {},
      vi.fn(),
    );
    expect(panel.result).toHaveTextContent("New session result");
    cleanup();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "AUTH_STATE_CHANGED" },
      {},
      vi.fn(),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("remembers the target, supports Escape, and cleans up idempotently", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Lifecycle";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const { container, ctx, cleanup, shadow } = await setup();
    let panel = open(container);
    await choose(shadow, panel.target, "Japanese");
    fireEvent.keyDown(panel.target, { key: "Escape" });
    await vi.waitFor(() =>
      expect(shadow.activeElement).toBe(getIcon(container)),
    );
    panel = open(container);
    expect(panel.target).toHaveTextContent("Japanese");

    ctx.notifyInvalidated();
    cleanup();
    expect(container).toBeEmptyDOMElement();
    select(paragraph.firstChild as Text);
    fireEvent.pointerUp(document);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps closed-shadow UI events out of document capture handling", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Closed shadow";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const host = document.createElement("readlace-selection-translator");
    const shadow = host.attachShadow({ mode: "closed" });
    const container = document.createElement("div");
    shadow.append(container);
    document.body.append(host);
    const ctx = new ContentScriptContext("closed-shadow-test", {
      noScriptStartedPostMessage: true,
    });
    mountSelectionTranslation(container, shadow, ctx);
    await vi.waitFor(() => expect(getIcon(container)).toBeInTheDocument());
    const panel = open(container);

    fireEvent.pointerUp(panel.target);
    expect(panel.dialog).toBeVisible();
    fireEvent.keyDown(panel.target, { key: "Escape" });
    fireEvent.keyUp(panel.target, { key: "Escape" });
    expect(getIcon(container)).toBeVisible();
    expect(document.activeElement).toBe(host);
    ctx.notifyInvalidated();
  });

  it("mounts the runtime entry once per isolated document", async () => {
    const host = document.createElement("readlace-selection-translator");
    const remove = vi.fn();
    vi.mocked(createShadowRootUi).mockResolvedValue({
      shadowHost: host,
      mount: vi.fn(),
      remove,
    } as never);
    const first = new ContentScriptContext("selection-runtime-first", {
      noScriptStartedPostMessage: true,
    });
    const duplicate = new ContentScriptContext("selection-runtime-duplicate", {
      noScriptStartedPostMessage: true,
    });

    await selectionUiContent.main(first);
    await selectionUiContent.main(duplicate);
    expect(createShadowRootUi).toHaveBeenCalledOnce();

    first.notifyInvalidated();
    expect(remove).toHaveBeenCalledOnce();
    await selectionUiContent.main(duplicate);
    expect(createShadowRootUi).toHaveBeenCalledTimes(2);
    duplicate.notifyInvalidated();
  });

  it("preserves one pending request through BFCache and cleans nonpersisted navigation", async () => {
    let host!: HTMLElement;
    let uiContainer!: HTMLElement;
    vi.mocked(createShadowRootUi).mockImplementation(async (_ctx, options) => {
      host = document.createElement("readlace-selection-translator");
      const shadow = host.attachShadow({ mode: "open" });
      uiContainer = document.createElement("div");
      shadow.append(uiContainer);
      let mounted: unknown;
      return {
        shadow,
        shadowHost: host,
        uiContainer,
        mount() {
          document.body.append(host);
          mounted = options.onMount(uiContainer, shadow, host);
        },
        remove() {
          options.onRemove?.(mounted);
          mounted = undefined;
          host.remove();
          uiContainer.replaceChildren();
        },
        autoMount: vi.fn(),
        get mounted() {
          return mounted;
        },
      } as never;
    });

    const paragraph = document.createElement("p");
    paragraph.append(
      document.createTextNode("First"),
      document.createTextNode("Second"),
    );
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const first = deferred<{ requestId: number; text: string }>();
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    let requestCount = 0;
    send.mockImplementation((message) => {
      const request = message as unknown as { type: string };
      if (request.type === "GET_SELECTION_TRANSLATION_CONTEXT")
        return Promise.resolve({ provider: "google" }) as never;
      // The panel asks the background for the UI locale on mount and open.
      if (request.type === "UI_LOCALE_GET")
        return Promise.resolve(undefined) as never;
      return (
        requestCount++ === 0
          ? first.promise
          : Promise.resolve({ requestId: 1, text: "Deuxième" })
      ) as never;
    });
    const ctx = new ContentScriptContext("selection-entrypoint-test", {
      noScriptStartedPostMessage: true,
    });
    await selectionUiContent.main(ctx);
    await vi.waitFor(() => expect(host.isConnected).toBe(true));
    let panel = open(uiContainer);
    fireEvent.click(panel.translate);
    expect(translationMessages()).toHaveLength(1);

    window.dispatchEvent(transition("pagehide", true));
    expect(host).toHaveAttribute("data-readlace-suspended");
    expect(host.isConnected).toBe(true);
    window.dispatchEvent(transition("pageshow", true));
    expect(host).not.toHaveAttribute("data-readlace-suspended");

    select(paragraph.lastChild as Text);
    fireEvent.pointerUp(paragraph);
    await settleSelectionRead();
    panel = open(uiContainer);
    expect(panel.translate).toBeDisabled();
    fireEvent.click(panel.translate);
    expect(translationMessages()).toHaveLength(1);
    first.resolve({ requestId: 0, text: "Stale" });
    await vi.waitFor(() => expect(panel.translate).not.toBeDisabled());
    expect(panel.result).toBeEmptyDOMElement();
    fireEvent.click(panel.translate);
    await vi.waitFor(() => expect(translationMessages()).toHaveLength(2));

    window.dispatchEvent(transition("pagehide", false));
    expect(host.isConnected).toBe(false);
    expect(uiContainer).toBeEmptyDOMElement();
    ctx.notifyInvalidated();
  });

  it("loads the fixed runtime UI only after selection and retries failures", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Lazy runtime";
    const blank = document.createElement("p");
    blank.textContent = "   ";
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.innerHTML =
      '<span contenteditable="false">Safe one</span> editable <span contenteditable="false">Safe two</span>';
    document.body.append(paragraph, blank, input, textarea, editor);
    const send = vi.mocked(fakeBrowser.runtime.sendMessage);
    let attempt = 0;
    send.mockImplementation(async (message) => {
      expect(message).toEqual({ type: "LOAD_SELECTION_TRANSLATION_UI" });
      return { loaded: ++attempt > 1 } as never;
    });
    const ctx = new ContentScriptContext("selection-bootstrap-test", {
      noScriptStartedPostMessage: true,
    });
    selectionContent.main(ctx);

    expect(send).not.toHaveBeenCalled();
    fireEvent.pointerUp(document);
    select(blank.firstChild as Text);
    fireEvent.pointerUp(blank);
    for (const editable of [input, textarea]) {
      const range = document.createRange();
      range.selectNode(editable);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.pointerUp(editable);
    }
    select(editor.childNodes[1] as Text);
    fireEvent.pointerUp(editor);
    const crossing = document.createRange();
    crossing.setStart(editor.firstElementChild!.firstChild as Text, 0);
    const last = editor.lastElementChild!.firstChild as Text;
    crossing.setEnd(last, last.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(crossing);
    fireEvent.pointerUp(editor);
    const getSelection = vi.spyOn(window, "getSelection");
    getSelection.mockReturnValueOnce({
      isCollapsed: false,
      rangeCount: 2,
    } as Selection);
    fireEvent.pointerUp(document);
    const shadowText = document
      .createElement("span")
      .attachShadow({ mode: "open" })
      .appendChild(document.createTextNode("Shadow"));
    getSelection.mockReturnValueOnce({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () =>
        ({
          startContainer: shadowText,
          endContainer: shadowText,
        }) as unknown as Range,
    } as unknown as Selection);
    fireEvent.pointerUp(document);
    getSelection.mockRestore();
    await settleSelectionRead();
    expect(send).not.toHaveBeenCalled();

    let pageEvent: { cancelled: boolean; prevented: boolean } | undefined;
    paragraph.addEventListener("dblclick", (event) => {
      pageEvent = {
        cancelled: event.cancelBubble,
        prevented: event.defaultPrevented,
      };
      select(paragraph.firstChild as Text);
    });
    window.getSelection()!.removeAllRanges();
    fireEvent.doubleClick(paragraph);
    expect(pageEvent).toEqual({ cancelled: false, prevented: false });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await Promise.resolve();
    fireEvent.keyUp(paragraph, { key: "Shift" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    fireEvent.pointerUp(paragraph);
    expect(send).toHaveBeenCalledTimes(2);
    ctx.notifyInvalidated();
  });

  it("keeps the manifest bootstrap free of UI runtime imports", () => {
    const source = readFileSync("entrypoints/selection.content.ts", "utf8");

    expect(source).not.toContain("SelectionTranslationPanel");
    expect(source).not.toContain("react-dom");
    expect(source).not.toContain("selection.css");
    expect(source).not.toContain("mountSelectionTranslation");
    expect(source).toContain('type: "LOAD_SELECTION_TRANSLATION_UI"');
    expect(source).toContain(
      'addEventListener("dblclick", scheduleLoad, true)',
    );
  });

  it("asks the background for the locale and shows mapped errors in it", async () => {
    let locale: "en" | "vi" = "en";
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation(
      async (message) => {
        const request = message as unknown as {
          type?: string;
          requestId?: number;
        };
        if (request.type === "UI_LOCALE_GET")
          return { locale, stored: locale } as never;
        return { requestId: request.requestId, error: "too-long" } as never;
      },
    );
    const paragraph = document.createElement("p");
    paragraph.textContent = "Readable page text";
    document.body.append(paragraph);
    select(paragraph.firstChild as Text);
    const { container, cleanup } = await setup();
    const panel = open(container);
    expect(panel.translate).toHaveTextContent("Translate");

    // The choice made in the popup applies on the next open.
    locale = "vi";
    fireEvent.click(panel.close);
    fireEvent.click(
      container.querySelector('[data-role="selection-trigger"]')!,
    );
    await vi.waitFor(() => expect(panel.translate).toHaveTextContent("Dịch"));
    expect(
      container.querySelector('[role="combobox"][aria-label="Dịch sang"]'),
    ).not.toBeNull();
    fireEvent.click(panel.translate);
    await vi.waitFor(() =>
      expect(panel.status).toHaveTextContent("Đoạn đã chọn quá dài để dịch."),
    );
    const requests = vi
      .mocked(fakeBrowser.runtime.sendMessage)
      .mock.calls.map(([message]) => (message as { type?: string }).type);
    expect(requests.filter((type) => type === "UI_LOCALE_GET").length).toBe(3);
    cleanup();
  });
});
