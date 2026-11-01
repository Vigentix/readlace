import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ContentScriptContext } from "wxt/utils/content-script-context";

import contentScript from "@/entrypoints/content";
import * as layout from "@/lib/translate/layout-ellipsis";

type RuntimeMessage = Record<string, unknown> & { type: string };

async function sendContentMessage(message: RuntimeMessage) {
  let response: Record<string, unknown> | undefined;
  await fakeBrowser.runtime.onMessage.trigger(message, {}, (value) => {
    response = value as Record<string, unknown>;
  });
  await vi.waitFor(() => expect(response).toBeDefined(), { timeout: 3_500 });
  return response!;
}

function startContent(id: string) {
  const ctx = new ContentScriptContext(id, {
    noScriptStartedPostMessage: true,
  });
  contentScript.main(ctx);
  return ctx;
}

const translated = (target: string, source: string) =>
  `${target.toUpperCase()}:${source}`;
const originalBoundingClientRect = Element.prototype.getBoundingClientRect;

describe("content runtime lifecycle", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    // jsdom has no layout. These lifecycle fixtures represent rendered page
    // records; tests for scrolling/hidden content override geometry or styles.
    Element.prototype.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 10,
        top: 10,
        bottom: 30,
        left: 10,
        right: 110,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalBoundingClientRect;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "retains a successful hidden Text slot until reveal without retry, fallback or premature cache (visible acceptance=%s)",
    async (visibleAcceptance) => {
      document.body.innerHTML = `<p>${visibleAcceptance ? "Visible slot " : ""}<span id="deferred">Deferred slot</span></p>`;
      const deferredElement = document.querySelector("span")!;
      const deferredNode = deferredElement.firstChild as Text;
      const visibleNode = document.querySelector("p")!.firstChild;
      const capture = vi.spyOn(layout, "captureLayoutConstraint");
      const messages: RuntimeMessage[] = [];
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        messages.push(message);
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "AUTHORIZE_TRANSLATION_COMMIT")
          return { ok: true, runId: message.runId };
        if (message.type === "TRANSLATE_HTML") {
          deferredElement.style.visibility = "hidden";
          const results = (message.pieces as string[][]).map((row) =>
            row.map((text) => translated("en", text)),
          );
          return { results, cacheableResults: results };
        }
        return undefined;
      }) as never);
      const ctx = startContent("defer-hidden-provider-success");
      try {
        const result = await sendContentMessage({
          type: "START_TRANSLATION",
          targetLanguage: "en",
        });
        expect(result.state).toBe(visibleAcceptance ? "partial" : "error");
        if (visibleAcceptance)
          expect(visibleNode!.textContent).toBe("EN:Visible slot ");
        expect(deferredNode.data).toBe("Deferred slot");
        expect(capture.mock.calls.some(([node]) => node === deferredNode)).toBe(
          false,
        );
        await new Promise((resolve) => setTimeout(resolve, 650));
        await expect(
          sendContentMessage({ type: "CONTENT_STATE" }),
        ).resolves.toMatchObject({
          state: visibleAcceptance ? "partial" : "error",
        });
        expect(
          messages.filter((message) => message.type === "TRANSLATE_HTML"),
        ).toHaveLength(1);
        expect(
          messages.some((message) => /FALLBACK|NATIVE/.test(message.type)),
        ).toBe(false);
        expect(
          messages.some(
            (message) => message.type === "AUTHORIZE_TRANSLATION_COMMIT",
          ),
        ).toBe(false);
        expect(
          messages
            .filter((message) => message.type.startsWith("CACHE_ACCEPTED"))
            .flatMap((message) => (message.sources as string[][]).flat()),
        ).not.toContain("Deferred slot");
        deferredElement.style.visibility = "visible";
        await vi.waitFor(() =>
          expect(deferredNode.data).toBe("EN:Deferred slot"),
        );
        await vi.waitFor(() =>
          expect(
            messages
              .filter((message) => message.type.startsWith("CACHE_ACCEPTED"))
              .flatMap((message) => (message.sources as string[][]).flat())
              .filter((source) => source === "Deferred slot"),
          ).toHaveLength(1),
        );
        expect(
          messages.filter((message) => message.type === "TRANSLATE_HTML"),
        ).toHaveLength(1);
        await sendContentMessage({ type: "SHOW_ORIGINAL" });
        expect(document.querySelector("span")!.firstChild).toBe(deferredNode);
        expect(deferredNode.data).toBe("Deferred slot");
        if (visibleAcceptance)
          expect(visibleNode!.textContent).toBe("Visible slot ");
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it.each(["google-fallback", "chain-hit"])(
    "preserves %s provenance when a successful backend slot becomes hidden",
    async (origin) => {
      document.body.innerHTML =
        '<p>Visible source</p><p id="pending">Pending source</p>';
      const pendingElement = document.querySelector("#pending") as HTMLElement;
      const pendingNode = pendingElement.firstChild as Text;
      const messages: RuntimeMessage[] = [];
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        messages.push(message);
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "AUTHORIZE_TRANSLATION_COMMIT")
          return { ok: true, runId: message.runId };
        if (message.type === "TRANSLATE_HTML") {
          const pieces = message.pieces as string[][];
          const results = pieces.map((row) =>
            row.map((source) => translated("en", source)),
          );
          pendingElement.style.visibility = "hidden";
          return {
            results,
            cacheableResults:
              origin === "chain-hit"
                ? results.map((row) => row.map(() => ""))
                : results,
            // The backend's Google fallback produced the pending record.
            provenance:
              origin === "google-fallback"
                ? pieces.map((row) =>
                    row.map((source) =>
                      source === "Pending source" ? "google" : undefined,
                    ),
                  )
                : pieces.map((row) => row.map(() => undefined)),
            failures: [],
          };
        }
        return undefined;
      }) as never);
      const ctx = startContent(`deferred-provenance-${origin}`);
      try {
        await expect(
          sendContentMessage({
            type: "START_TRANSLATION",
            targetLanguage: "en",
          }),
        ).resolves.toMatchObject({ state: "partial" });
        expect(pendingNode.data).toBe("Pending source");
        expect(
          messages.some(
            (message) => message.type === "CACHE_ACCEPTED_GOOGLE_HTML",
          ),
        ).toBe(false);
        expect(
          messages.some(
            (message) => message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK",
          ),
        ).toBe(false);
        pendingElement.style.visibility = "visible";
        await vi.waitFor(() =>
          expect(pendingNode.data).toBe("EN:Pending source"),
        );
        await vi.waitFor(async () =>
          expect(
            (await sendContentMessage({ type: "CONTENT_STATE" })).state,
          ).toBe("translated"),
        );
        expect(
          messages.filter((message) => message.type === "TRANSLATE_HTML"),
        ).toHaveLength(1);
        if (origin === "chain-hit")
          expect(
            messages.some((message) =>
              message.type.startsWith("CACHE_ACCEPTED"),
            ),
          ).toBe(false);
        else
          expect(
            messages.filter(
              (message) => message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK",
            ),
          ).toEqual([
            expect.objectContaining({
              sources: [["Pending source"]],
              results: [["EN:Pending source"]],
              provenance: "google",
            }),
          ]);
        expect(
          messages.some(
            (message) => message.type === "CACHE_ACCEPTED_GOOGLE_HTML",
          ),
        ).toBe(false);
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it.each([
    "restore",
    "new-generation",
    "auth-denial",
    "new-login",
    "auth-unavailable",
    "wrong-run",
    "stale-source",
  ])(
    "retires hidden accepted results on %s without losing new source discovery",
    async (retirement) => {
      document.body.innerHTML =
        '<p>Visible source</p><p id="pending">Pending source</p>';
      const pendingElement = document.querySelector("#pending") as HTMLElement;
      const pendingNode = pendingElement.firstChild as Text;
      const messages: RuntimeMessage[] = [];
      let requests = 0;
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        messages.push(message);
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "AUTH_STATUS")
          return {
            authenticated: true,
            user: { email: "new-account@example.com" },
          };
        if (message.type === "AUTHORIZE_TRANSLATION_COMMIT") {
          if (["auth-denial", "new-login"].includes(retirement))
            return { error: "auth-required", runId: message.runId };
          if (retirement === "auth-unavailable")
            return { error: "auth-unavailable", runId: message.runId };
          if (retirement === "wrong-run") return { ok: true, runId: -1 };
          return { ok: true, runId: message.runId };
        }
        if (message.type === "TRANSLATE_HTML") {
          requests += 1;
          if (requests === 1) pendingElement.style.visibility = "hidden";
          const results = (message.pieces as string[][]).map((row) =>
            row.map((text) =>
              translated(message.targetLanguage as string, text),
            ),
          );
          return { results, cacheableResults: results };
        }
        return undefined;
      }) as never);
      const ctx = startContent(`pending-retirement-${retirement}`);
      try {
        await expect(
          sendContentMessage({
            type: "START_TRANSLATION",
            targetLanguage: "en",
          }),
        ).resolves.toMatchObject({ state: "partial" });
        expect(pendingNode.data).toBe("Pending source");
        if (retirement === "restore")
          await sendContentMessage({ type: "SHOW_ORIGINAL" });
        if (retirement === "stale-source") pendingNode.data = "New host source";
        pendingElement.style.visibility = "visible";
        if (retirement === "new-generation") {
          await sendContentMessage({
            type: "START_TRANSLATION",
            targetLanguage: "en",
          });
          expect(pendingNode.data).toBe("EN:Pending source");
          expect(requests).toBe(2);
        } else if (retirement === "stale-source") {
          await vi.waitFor(() =>
            expect(pendingNode.data).toBe("EN:New host source"),
          );
          expect(
            messages
              .filter((message) => message.type.startsWith("CACHE_ACCEPTED"))
              .flatMap((message) => (message.sources as string[][]).flat()),
          ).not.toContain("Pending source");
        } else {
          await new Promise((resolve) => setTimeout(resolve, 650));
          expect(pendingNode.data).toBe("Pending source");
          expect(requests).toBe(1);
          if (
            [
              "auth-denial",
              "new-login",
              "auth-unavailable",
              "wrong-run",
            ].includes(retirement)
          ) {
            await expect(
              sendContentMessage({ type: "CONTENT_STATE" }),
            ).resolves.toMatchObject({
              error: ["auth-denial", "new-login"].includes(retirement)
                ? "auth-required"
                : "auth-unavailable",
              state: "partial",
            });
            expect(
              messages.some((message) => message.type === "AUTH_STATUS"),
            ).toBe(false);
            expect(
              messages
                .filter((message) => message.type.startsWith("CACHE_ACCEPTED"))
                .flatMap((message) => (message.sources as string[][]).flat()),
            ).not.toContain("Pending source");
          }
        }
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it("dispatches a hidden dropdown only after reveal and preserves extension-owned tooltips", async () => {
    document.body.innerHTML = `<p>Visible source</p>
      <section style="visibility:hidden"><p title="Hidden hint">Hidden source</p></section>
      <tryhand-ellipsis class="tryhand-ellipsis" title="Accepted tooltip"><span>Accepted tooltip</span></tryhand-ellipsis>`;
    const submitted: string[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        submitted.push(...pieces.flat());
        return {
          results: pieces.map((row) =>
            row.map((text) => translated("en", text)),
          ),
        };
      }
      if (message.type === "TRANSLATE_TEXT") {
        const texts = message.texts as string[];
        submitted.push(...texts);
        return { results: texts.map((text) => translated("en", text)) };
      }
      return undefined;
    }) as never);
    const ctx = startContent("hidden-reveal-owned-tooltip");
    try {
      await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      expect(submitted).toEqual(["Visible source"]);
      expect(document.querySelector("section p")!.textContent).toBe(
        "Hidden source",
      );
      (document.querySelector("section") as HTMLElement).style.visibility =
        "visible";
      await vi.waitFor(() =>
        expect(document.querySelector("section p")!.textContent).toBe(
          "EN:Hidden source",
        ),
      );
      await vi.waitFor(() =>
        expect(document.querySelector("section p")!.getAttribute("title")).toBe(
          "EN:Hidden hint",
        ),
      );
      expect(submitted.filter((text) => text === "Hidden source")).toHaveLength(
        1,
      );
      expect(submitted).not.toContain("Accepted tooltip");
      expect(
        document.querySelector("tryhand-ellipsis")!.getAttribute("title"),
      ).toBe("Accepted tooltip");
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      expect(document.querySelector("section p")!.textContent).toBe(
        "Hidden source",
      );
      expect(document.querySelector("section p")!.getAttribute("title")).toBe(
        "Hidden hint",
      );
    } finally {
      ctx.notifyInvalidated();
    }
  });

  it("translates native no-box option labels through their visible select owner and preserves values", async () => {
    document.body.innerHTML =
      '<select><option value="one">Readable one</option><option value="two">Readable two</option></select>';
    for (const option of document.querySelectorAll("option"))
      option.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML")
        return {
          results: (message.pieces as string[][]).map((row) =>
            row.map((text) => translated("en", text)),
          ),
        };
      return undefined;
    }) as never);
    const ctx = startContent("native-select-ownership");
    try {
      await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      expect(
        [...document.querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      ).toEqual(["EN:Readable one", "EN:Readable two"]);
      expect(
        [...document.querySelectorAll("option")].map((option) => option.value),
      ).toEqual(["one", "two"]);
      expect(document.querySelector("select")!.value).toBe("one");
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      expect(
        [...document.querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      ).toEqual(["Readable one", "Readable two"]);
      expect(document.querySelector("select")!.value).toBe("one");
    } finally {
      ctx.notifyInvalidated();
    }
  });

  it("translates opt-out text, attributes, and title while preserving typed values and exact restore", async () => {
    document.documentElement.setAttribute("translate", "no");
    document.head.innerHTML =
      '<title class="notranslate" translate="no">Opt-out title</title>';
    document.body.innerHTML = `<section class="notranslate" translate="no"><p>Opt-out text</p>
      <input translate="no" placeholder="Opt-out placeholder" value="Typed value">
      <textarea class="notranslate" placeholder="Opt-out textarea">Typed text</textarea>
      <img class="notranslate" alt="Opt-out image"><p title="Opt-out hint">Hint text</p>
      <div contenteditable="true"><p title="Editor hint">Editor text</p></div>
      <code>Code source</code><math>Equation source</math></section>`;
    const original = document.body.innerHTML;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML")
        return {
          results: (message.pieces as string[][]).map((row) =>
            row.map((text) => translated("en", text)),
          ),
        };
      if (message.type === "TRANSLATE_TEXT")
        return {
          results: (message.texts as string[]).map((text) =>
            translated("en", text),
          ),
        };
      if (message.type === "TRANSLATE_SINGLE")
        return { text: translated("en", message.text as string) };
      return undefined;
    }) as never);
    const ctx = startContent("translate-nested-opt-outs");
    try {
      await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      expect(document.querySelector("p")!.textContent).toBe("EN:Opt-out text");
      expect(document.title).toBe("EN:Opt-out title");
      expect(document.querySelector("input")!.placeholder).toBe(
        "EN:Opt-out placeholder",
      );
      expect(document.querySelector("input")!.value).toBe("Typed value");
      expect(document.querySelector("textarea")!.placeholder).toBe(
        "EN:Opt-out textarea",
      );
      expect(document.querySelector("textarea")!.value).toBe("Typed text");
      expect(document.querySelector("img")!.alt).toBe("EN:Opt-out image");
      expect(document.querySelector("[contenteditable]")!.textContent).toBe(
        "Editor text",
      );
      expect(
        document.querySelector("[contenteditable] p")!.getAttribute("title"),
      ).toBe("Editor hint");
      expect(document.querySelector("code")!.textContent).toBe("Code source");
      expect(document.querySelector("math")!.textContent).toBe(
        "Equation source",
      );
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      expect(document.body.innerHTML).toBe(original);
      expect(document.title).toBe("Opt-out title");
    } finally {
      ctx.notifyInvalidated();
      document.documentElement.removeAttribute("translate");
    }
  });

  it.each(["true", "plaintext-only", ""])(
    "preserves a contenteditable=%s title without dispatching title translation",
    async (editable) => {
      document.head.innerHTML = `<title contenteditable="${editable}" translate="no">Editable title</title>`;
      document.body.innerHTML = "<p>Readable body</p>";
      const send = vi
        .spyOn(fakeBrowser.runtime, "sendMessage")
        .mockImplementation((async (raw: unknown) => {
          const message = raw as RuntimeMessage;
          if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
          if (message.type === "TRANSLATE_HTML")
            return { results: [["Translated body"]] };
          if (message.type === "TRANSLATE_SINGLE")
            return { text: "Translated title" };
          return undefined;
        }) as never);
      const ctx = startContent(`editable-title-${editable}`);
      try {
        await sendContentMessage({
          type: "START_TRANSLATION",
          targetLanguage: "en",
        });
        expect(document.title).toBe("Editable title");
        expect(document.querySelector("p")!.textContent).toBe(
          "Translated body",
        );
        expect(send).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "TRANSLATE_SINGLE" }),
        );
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it.each(["text", "element"])(
    "does not commit a stale title after the SPA changes its %s",
    async (change) => {
      document.title = "Source title";
      document.body.innerHTML = "<p>Source body</p>";
      let release!: (value: unknown) => void;
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "TRANSLATE_HTML")
          return { results: [["Translated body"]] };
        if (message.type === "TRANSLATE_SINGLE")
          return new Promise((resolve) => {
            release = resolve;
          });
        return undefined;
      }) as never);
      const ctx = startContent(`stale-title-${change}`);
      try {
        const completion = sendContentMessage({
          type: "START_TRANSLATION",
          targetLanguage: "en",
        });
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        if (change === "text") document.title = "SPA title";
        else {
          const replacement = document.createElement("title");
          replacement.textContent = "Source title";
          document.querySelector("title")!.replaceWith(replacement);
        }
        const currentTitle = document.title;
        release({ text: "Translated title" });
        await completion;
        expect(document.title).toBe(currentTitle);
        await sendContentMessage({ type: "SHOW_ORIGINAL" });
        expect(document.title).toBe(currentTitle);
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it.each(["text", "element"])(
    "does not restore a translated title after the SPA changes its %s",
    async (change) => {
      document.title = "Source title";
      document.body.innerHTML = "<p>Source body</p>";
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "TRANSLATE_HTML")
          return { results: [["Translated body"]] };
        if (message.type === "TRANSLATE_SINGLE")
          return { text: "Translated title" };
        return undefined;
      }) as never);
      const ctx = startContent(`restore-title-ownership-${change}`);
      try {
        await sendContentMessage({
          type: "START_TRANSLATION",
          targetLanguage: "en",
        });
        expect(document.title).toBe("Translated title");
        if (change === "text") document.title = "SPA title";
        else {
          const replacement = document.createElement("title");
          replacement.textContent = "Translated title";
          document.querySelector("title")!.replaceWith(replacement);
        }
        const currentTitle = document.title;
        await sendContentMessage({ type: "SHOW_ORIGINAL" });
        expect(document.title).toBe(currentTitle);
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it.each([
    "BEGIN_TRANSLATION_RUN",
    "TRANSLATE_HTML",
    "TRANSLATE_TEXT",
    "TRANSLATE_SINGLE",
    "PREPARE_NATIVE_TRANSLATOR",
    "TRANSLATE_NATIVE_TEXT",
  ])("stops the whole run on terminal auth from %s", async (terminalStage) => {
    document.body.innerHTML =
      terminalStage === "TRANSLATE_TEXT"
        ? '<input title="日本語の属性">'
        : "<p>日本語の本文</p>";
    if (terminalStage === "TRANSLATE_SINGLE") document.title = "日本語の題名";
    const original = document.body.innerHTML;
    const messages: RuntimeMessage[] = [];
    for (const error of ["auth-required", "auth-unavailable"] as const) {
      document.body.innerHTML = original;
      const node = document.querySelector("p")?.firstChild;
      messages.length = 0;
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        messages.push(message);
        if (message.type === terminalStage) {
          if (terminalStage === "TRANSLATE_SINGLE")
            await vi.waitFor(() =>
              expect(node!.textContent).toBe("EN:日本語の本文"),
            );
          return { error, runId: message.runId };
        }
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "TRANSLATE_HTML")
          return {
            results: (message.pieces as string[][]).map((row) =>
              row.map((source) =>
                terminalStage === "TRANSLATE_SINGLE" ? `EN:${source}` : "",
              ),
            ),
            failures: [
              { index: 0, scope: "record", retryable: false, message: "empty" },
            ],
          };
        if (message.type === "PREPARE_NATIVE_TRANSLATOR")
          return { progress: { phase: "ready" } };
        return undefined;
      }) as never);
      const ctx = startContent(`auth-${terminalStage}-${error}`);
      try {
        const result = await sendContentMessage({
          type: "START_TRANSLATION",
          targetLanguage: "en",
        });
        expect(result).toMatchObject({
          ok: false,
          error,
          state: terminalStage === "TRANSLATE_SINGLE" ? "partial" : "error",
        });
        await expect(
          sendContentMessage({ type: "WAIT_FOR_CONTENT_TERMINAL_STATE" }),
        ).resolves.toMatchObject({ error });
        const terminalIndex = messages.findIndex(
          (message) => message.type === terminalStage,
        );
        expect(terminalIndex).toBeGreaterThanOrEqual(0);
        expect(
          messages
            .slice(terminalIndex + 1)
            .filter((message) =>
              /^(TRANSLATE_|PREPARE_NATIVE|CACHE_ACCEPTED)/.test(message.type),
            ),
        ).toEqual([]);
        if (node) expect(document.querySelector("p")!.firstChild).toBe(node);
        await sendContentMessage({ type: "SHOW_ORIGINAL" });
        expect(document.body.innerHTML).toBe(original);
        if (terminalStage === "TRANSLATE_SINGLE")
          expect(document.title).toBe("日本語の題名");
      } finally {
        ctx.notifyInvalidated();
      }
    }
  });

  it("authorizes target changes before restoring accepted DOM and preserves restore after denial", async () => {
    document.body.innerHTML =
      '<p>Exact source</p><input title="Exact attribute">';
    document.title = "Exact title";
    const node = document.querySelector("p")!.firstChild;
    let deny = false;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return deny ? { error: "auth-unavailable" } : { ok: true };
      if (message.type === "TRANSLATE_HTML")
        return {
          results: (message.pieces as string[][]).map((row) =>
            row.map((text) => `EN:${text}`),
          ),
        };
      if (message.type === "TRANSLATE_TEXT")
        return {
          results: (message.texts as string[]).map((text) => `EN:${text}`),
        };
      if (message.type === "TRANSLATE_SINGLE")
        return { text: `EN:${message.text}` };
      return undefined;
    }) as never);
    const ctx = startContent("denied-target-preserves-dom");
    try {
      await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      deny = true;
      await expect(
        sendContentMessage({ type: "START_TRANSLATION", targetLanguage: "vi" }),
      ).resolves.toMatchObject({
        ok: false,
        error: "auth-unavailable",
        translated: true,
        appliedTarget: "en",
      });
      expect(node!.textContent).toBe("EN:Exact source");
      expect(document.querySelector("input")!.title).toBe("EN:Exact attribute");
      expect(document.title).toBe("EN:Exact title");
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      expect(document.querySelector("p")!.firstChild).toBe(node);
      expect(node!.textContent).toBe("Exact source");
      expect(document.querySelector("input")!.title).toBe("Exact attribute");
      expect(document.title).toBe("Exact title");
    } finally {
      ctx.notifyInvalidated();
    }
  });

  it.each(["BEGIN_TRANSLATION_RUN", "TRANSLATE_NATIVE_TEXT"])(
    "settles start and terminal waiters on invalidation while %s is pending",
    async (pendingStage) => {
      document.body.innerHTML = "<p>日本語の本文</p>";
      let release!: (value: unknown) => void;
      const messages: RuntimeMessage[] = [];
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        raw: unknown,
      ) => {
        const message = raw as RuntimeMessage;
        messages.push(message);
        if (message.type === pendingStage)
          return new Promise((resolve) => {
            release = resolve;
          });
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "TRANSLATE_HTML")
          return {
            results: [[""]],
            failures: [{ index: 0, retryable: false }],
          };
        if (message.type === "TRANSLATE_GOOGLE_FALLBACK_TEXT")
          return { runId: message.runId, results: [""], attempted: true };
        return undefined;
      }) as never);
      const ctx = startContent(`pending-${pendingStage}`);
      try {
        const startResponse = vi.fn();
        await fakeBrowser.runtime.onMessage.trigger(
          { type: "START_TRANSLATION", targetLanguage: "en" },
          {},
          startResponse,
        );
        await vi.waitFor(() => expect(release).toBeDefined());
        const waiter = vi.fn();
        await fakeBrowser.runtime.onMessage.trigger(
          { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
          {},
          waiter,
        );
        expect(waiter).not.toHaveBeenCalled();
        const eventResponse = vi.fn();
        await fakeBrowser.runtime.onMessage.trigger(
          { type: "AUTH_STATE_CHANGED" },
          {},
          eventResponse,
        );
        await vi.waitFor(() =>
          expect(startResponse).toHaveBeenCalledWith(
            expect.objectContaining({ error: "auth-required", state: "error" }),
          ),
        );
        expect(waiter).toHaveBeenCalledWith(
          expect.objectContaining({ error: "auth-required", state: "error" }),
        );
        expect(eventResponse).not.toHaveBeenCalled();
        const boundary = messages.length;
        release({
          ok: true,
          runId: 1,
          results: [{ status: "accepted", text: "Late result" }],
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.querySelector("p")!.textContent).toBe("日本語の本文");
        expect(
          messages
            .slice(boundary)
            .filter((message) =>
              /^(TRANSLATE_|CACHE_ACCEPTED)/.test(message.type),
            ),
        ).toEqual([]);
      } finally {
        ctx.notifyInvalidated();
      }
    },
  );

  it("keeps accepted chunks and resumes only unresolved and newly discovered records after a new BEGIN", async () => {
    // Keep collection and batch selection within budget so the controlled yield
    // below occurs between DOM chunks, independent of concurrent test load.
    const budgetClock = vi.spyOn(performance, "now").mockReturnValue(0);
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_, index) => `<p>Source ${index}</p>`,
    ).join("");
    const nodes = Array.from(
      document.querySelectorAll("p"),
      (element) => element.firstChild!,
    );
    const requests: string[][] = [];
    let release!: () => void;
    vi.stubGlobal("scheduler", {
      yield: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces.flat());
        return {
          results: pieces.map((row) => row.map((text) => `EN:${text}`)),
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("auth-between-chunks");
    try {
      const startResponse = vi.fn();
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "START_TRANSLATION", targetLanguage: "en" },
        {},
        startResponse,
      );
      await vi.waitFor(() =>
        expect(
          nodes.filter((node) => node.textContent!.startsWith("EN:")),
        ).toHaveLength(4),
      );
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "AUTH_STATE_CHANGED" },
        {},
        vi.fn(),
      );
      const retained = nodes.filter((node) =>
        node.textContent!.startsWith("EN:"),
      );
      expect(requests).toEqual([nodes.map((_, index) => `Source ${index}`)]);
      expect(retained).toHaveLength(4);
      release();
      vi.stubGlobal("scheduler", { yield: async () => undefined });
      await vi.waitFor(() =>
        expect(startResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            state: "partial",
            translated: true,
            appliedTarget: "en",
          }),
        ),
      );
      document.body.insertAdjacentHTML("beforeend", "<p>New source</p>");
      const boundary = requests.length;
      await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      expect(requests.slice(boundary).flat().sort()).toEqual(
        [
          ...Array.from({ length: 8 }, (_, index) => `Source ${index + 4}`),
          "New source",
        ].sort(),
      );
      expect(
        nodes.every((node) => node.textContent!.startsWith("EN:Source")),
      ).toBe(true);
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      nodes.forEach((node, index) => {
        expect(document.querySelectorAll("p")[index]!.firstChild).toBe(node);
        expect(node.textContent).toBe(`Source ${index}`);
      });
    } finally {
      ctx.notifyInvalidated();
      budgetClock.mockRestore();
    }
  });

  it("cancels retry, queued batches and scroll discovery while ignoring another batch's late reply", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      Array.from(
        { length: 40 },
        (_, index) => `<p>Source ${index} ${"word ".repeat(100)}</p>`,
      ).join("") + '<p id="lazy-auth">Lazy source</p>';
    const firstNode = document.querySelector("p")!.firstChild!;
    const firstSource = firstNode.textContent;
    const lazy = document.querySelector("#lazy-auth")!;
    let lazyTop = 5000;
    vi.spyOn(lazy, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: lazyTop,
          top: lazyTop,
          bottom: lazyTop + 20,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
        }) as DOMRect,
    );
    const requests: string[][][] = [];
    let release!: (value: unknown) => void;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces);
        if (requests.length === 2)
          return new Promise((resolve) => {
            release = resolve;
          });
        return {
          results: pieces.map((row, index) =>
            row.map((text) => (index === 0 ? `EN:${text}` : "")),
          ),
          failures: pieces.slice(1).map((_, index) => ({
            index: index + 1,
            scope: "record",
            retryable: true,
            retryAfterMs: 30000,
            message: "retry later",
          })),
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("auth-queued-work");
    try {
      const startResponse = vi.fn();
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "START_TRANSLATION", targetLanguage: "en" },
        {},
        startResponse,
      );
      await vi.waitFor(() =>
        expect(firstNode.textContent).toBe(`EN:${firstSource}`),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const waiter = vi.fn();
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
        {},
        waiter,
      );
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "AUTH_STATE_CHANGED" },
        {},
        vi.fn(),
      );
      expect(waiter).toHaveBeenCalledWith(
        expect.objectContaining({ state: "partial", error: "auth-required" }),
      );
      const boundary = requests.length;
      const acceptedBefore = document.body.textContent;
      lazyTop = 0;
      document.body.insertAdjacentHTML(
        "beforeend",
        "<p>Added after invalidation</p>",
      );
      release({
        results: requests[1]!.map((row) => row.map(() => "Late result")),
      });
      await vi.advanceTimersByTimeAsync(35000);
      expect(requests).toHaveLength(boundary);
      expect(document.body.textContent).toBe(
        `${acceptedBefore}Added after invalidation`,
      );
      expect(startResponse).toHaveBeenCalledWith(
        expect.objectContaining({ state: "partial", error: "auth-required" }),
      );
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      expect(document.querySelector("p")!.firstChild).toBe(firstNode);
      expect(firstNode.textContent).toBe(firstSource);
    } finally {
      ctx.notifyInvalidated();
    }
  });

  it("keeps the CONTENT_STATE response contract", async () => {
    const ctx = new ContentScriptContext("content-state-test", {
      noScriptStartedPostMessage: true,
    });
    contentScript.main(ctx);
    const sendResponse = vi.fn();

    await fakeBrowser.runtime.onMessage.trigger(
      { type: "CONTENT_STATE" },
      {},
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      state: "original",
      targetLanguage: "en",
      translated: false,
      appliedTarget: undefined,
      hasUnresolved: false,
      nativeRecoveryProgress: undefined,
      translationPath: "provider",
    });
    const terminalResponse = vi.fn();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
      {},
      terminalResponse,
    );
    expect(terminalResponse).toHaveBeenCalledWith({
      state: "original",
      targetLanguage: "en",
      translated: false,
      appliedTarget: undefined,
      hasUnresolved: false,
      nativeRecoveryProgress: undefined,
      translationPath: "provider",
    });
    ctx.notifyInvalidated();
  });

  it("releases its listener, timer, and observer on invalidation", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const addListener = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");
    const removeListener = vi.spyOn(
      fakeBrowser.runtime.onMessage,
      "removeListener",
    );
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue({
      ok: true,
    } as never);
    const ctx = new ContentScriptContext("lifecycle-test", {
      noScriptStartedPostMessage: true,
    });
    contentScript.main(ctx);
    const onContentMessage = addListener.mock.calls[0]![0];

    await fakeBrowser.runtime.onMessage.trigger(
      { type: "START_TRANSLATION", targetLanguage: "en" },
      {},
      vi.fn(),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ctx.notifyInvalidated();
    await Promise.resolve();

    expect(removeListener).toHaveBeenCalledWith(onContentMessage);
    expect(clearTimeout).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not answer a start that finishes after invalidation", async () => {
    let resolveStart!: (value: { ok: true }) => void;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type !== "BEGIN_TRANSLATION_RUN") return undefined;
      return await new Promise((resolve) => {
        resolveStart = resolve;
      });
    }) as never);
    const ctx = new ContentScriptContext("stale-start-test", {
      noScriptStartedPostMessage: true,
    });
    contentScript.main(ctx);
    const sendResponse = vi.fn();

    await fakeBrowser.runtime.onMessage.trigger(
      { type: "START_TRANSLATION", targetLanguage: "en" },
      {},
      sendResponse,
    );
    ctx.notifyInvalidated();
    resolveStart({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("answers a superseded start without mutating the current generation", async () => {
    document.body.innerHTML = '<p id="source">Current source</p>';
    let beginCount = 0;
    let resolveFirst!: (value: { ok: true }) => void;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") {
        beginCount += 1;
        if (beginCount === 1)
          return await new Promise((resolve) => {
            resolveFirst = resolve;
          });
        return { ok: true };
      }
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        return {
          results: pieces.map((row) => row.map((source) => `VI:${source}`)),
          failures: [],
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("superseded-start-test");
    const firstResponse = vi.fn();
    const secondResponse = vi.fn();

    await fakeBrowser.runtime.onMessage.trigger(
      { type: "START_TRANSLATION", targetLanguage: "en" },
      {},
      firstResponse,
    );
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "START_TRANSLATION", targetLanguage: "vi" },
      {},
      secondResponse,
    );
    await vi.waitFor(() =>
      expect(secondResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          state: "translated",
          targetLanguage: "vi",
        }),
      ),
    );

    resolveFirst({ ok: true });
    await vi.waitFor(() =>
      expect(firstResponse).toHaveBeenCalledWith({
        ok: false,
        state: "error",
        targetLanguage: "en",
        translated: false,
        appliedTarget: undefined,
        hasUnresolved: false,
      }),
    );
    expect(firstResponse).toHaveBeenCalledOnce();
    await expect(
      sendContentMessage({ type: "CONTENT_STATE" }),
    ).resolves.toMatchObject({
      state: "translated",
      targetLanguage: "vi",
      appliedTarget: "vi",
    });
    expect(document.querySelector("#source")!.textContent).toBe(
      "VI:Current source",
    );
    ctx.notifyInvalidated();
  });

  it("does not start another run for an already translated target", async () => {
    document.body.innerHTML = "<p>Source text</p>";
    const messages: RuntimeMessage[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as RuntimeMessage;
      messages.push(message);
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML")
        return {
          results: (message.pieces as string[][]).map((row) =>
            row.map((source) => `EN:${source}`),
          ),
          failures: [],
        };
      return undefined;
    }) as never);
    const ctx = startContent("translated-target-guard");
    const providerCallCount = () =>
      messages.filter(
        (message) =>
          message.type === "BEGIN_TRANSLATION_RUN" ||
          message.type.startsWith("TRANSLATE_"),
      ).length;

    await expect(
      sendContentMessage({ type: "START_TRANSLATION", targetLanguage: "en" }),
    ).resolves.toMatchObject({ state: "translated", appliedTarget: "en" });
    const providerCalls = providerCallCount();

    await expect(
      sendContentMessage({ type: "START_TRANSLATION", targetLanguage: "en" }),
    ).resolves.toMatchObject({ state: "translated", appliedTarget: "en" });
    expect(providerCallCount()).toBe(providerCalls);
    ctx.notifyInvalidated();
  });

  it.each([
    {
      terminalState: "translated",
      html: '<p id="accepted">Accepted source</p>',
    },
    {
      terminalState: "partial",
      html: '<p id="accepted">Accepted source</p><p>Unresolved source</p>',
    },
  ])(
    "holds multiple terminal waiters until busy becomes $terminalState",
    async ({ terminalState, html }) => {
      document.body.innerHTML = html;
      let releaseTranslation!: () => void;
      let markRequested!: () => void;
      const translationGate = new Promise<void>((resolve) => {
        releaseTranslation = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
        rawMessage: unknown,
      ) => {
        const message = rawMessage as unknown as RuntimeMessage;
        if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
        if (message.type === "TRANSLATE_HTML") {
          markRequested();
          await translationGate;
          const pieces = message.pieces as string[][];
          return {
            results: pieces.map((row) =>
              row.map((source) =>
                source.startsWith("Unresolved") ? "" : `EN:${source}`,
              ),
            ),
            failures: pieces.flatMap((row, index) =>
              row.some((source) => source.startsWith("Unresolved"))
                ? [
                    {
                      index,
                      scope: "record" as const,
                      message: "unresolved",
                      retryable: false,
                    },
                  ]
                : [],
            ),
          };
        }
        return undefined;
      }) as never);
      const ctx = startContent(`terminal-waiter-${terminalState}`);
      const startResponse = vi.fn();
      const firstWaiter = vi.fn();
      const secondWaiter = vi.fn();

      await fakeBrowser.runtime.onMessage.trigger(
        { type: "START_TRANSLATION", targetLanguage: "en" },
        {},
        startResponse,
      );
      await requested;
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
        {},
        firstWaiter,
      );
      await fakeBrowser.runtime.onMessage.trigger(
        { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
        {},
        secondWaiter,
      );
      expect(firstWaiter).not.toHaveBeenCalled();
      expect(secondWaiter).not.toHaveBeenCalled();

      releaseTranslation();
      await vi.waitFor(() => {
        expect(firstWaiter).toHaveBeenCalledWith(
          expect.objectContaining({
            state: terminalState,
            targetLanguage: "en",
            translated: true,
            appliedTarget: "en",
            hasUnresolved: terminalState === "partial",
          }),
        );
        expect(secondWaiter).toHaveBeenCalledOnce();
      });
      ctx.notifyInvalidated();
    },
  );

  it("cleans terminal waiters without responding after invalidation", async () => {
    document.body.innerHTML = "<p>Delayed source</p>";
    let releaseTranslation!: () => void;
    let markRequested!: () => void;
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        markRequested();
        await translationGate;
        return {
          results: (message.pieces as string[][]).map((row) =>
            row.map((source) => `EN:${source}`),
          ),
          failures: [],
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("terminal-waiter-invalidation");
    const terminalResponse = vi.fn();

    await fakeBrowser.runtime.onMessage.trigger(
      { type: "START_TRANSLATION", targetLanguage: "en" },
      {},
      vi.fn(),
    );
    await requested;
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
      {},
      terminalResponse,
    );
    ctx.notifyInvalidated();
    releaseTranslation();
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalResponse).not.toHaveBeenCalled();
  });

  it("retries only unresolved records three total times before settling", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <p id="accepted">Accepted source</p>
      <p id="retried">Retried source</p>
    `;
    const acceptedNode = document.querySelector("#accepted")!.firstChild!;
    const retriedNode = document.querySelector("#retried")!.firstChild!;
    const requests: string[][] = [];
    const requestTimes: number[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces.flat());
        requestTimes.push(performance.now());
        const attempt = requests.length;
        return {
          results: pieces.map((row) =>
            row.map((source) =>
              source === "Retried source" && attempt < 3
                ? ""
                : translated("en", source),
            ),
          ),
          failures: pieces.flatMap((row, index) =>
            row.includes("Retried source") && attempt < 3
              ? [
                  {
                    index,
                    scope: "record" as const,
                    message: "unresolved",
                    retryable: true,
                  },
                ]
              : [],
          ),
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("bounded-retry-test");
    const completion = sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });

    await vi.waitFor(() =>
      expect(acceptedNode.textContent).toBe("EN:Accepted source"),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.sort()).toEqual(["Accepted source", "Retried source"]);
    expect(acceptedNode.textContent).toBe("EN:Accepted source");
    expect(retriedNode.textContent).toBe("Retried source");

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual(["Retried source"]);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(500);

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toEqual(["Retried source"]);
    expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(1_500);

    await expect(completion).resolves.toMatchObject({ state: "translated" });
    expect(retriedNode.textContent).toBe("EN:Retried source");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests).toHaveLength(3);
    ctx.notifyInvalidated();
  });

  it("settles error when a Google record stays source-identical for all three attempts", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<p id="unresolved">未翻訳品質</p>`;
    let requests = 0;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "ja" };
      if (message.type === "TRANSLATE_HTML") {
        requests += 1;
        return {
          results: [[]],
          failures: [
            {
              index: 0,
              scope: "record" as const,
              message: "Translation provider returned untranslated text",
              retryable: true,
            },
          ],
        };
      }
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { availability: "unavailable", ready: false };
      if (message.type === "TRANSLATE_NATIVE_TEXT")
        return {
          runId: message.runId,
          results: [{ status: "unavailable", reason: "unsupported" }],
        };
      return undefined;
    }) as never);
    startContent("google-source-identical-terminal-test");
    const completion = sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await vi.waitFor(() => expect(requests).toBe(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(requests).toBe(2));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(requests).toBe(3));
    await expect(completion).resolves.toMatchObject({ state: "error" });
    expect(document.querySelector("#unresolved")).toHaveTextContent(
      "未翻訳品質",
    );
  });

  it("settles partial without a fourth request after retry exhaustion", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <p>Accepted source</p>
      <p id="unresolved">Unresolved source</p>
    `;
    const requests: string[][] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces.flat());
        return {
          results: pieces.map((row) =>
            row.map((source) =>
              source === "Unresolved source" ? "" : translated("en", source),
            ),
          ),
          failures: pieces.flatMap((row, index) =>
            row.includes("Unresolved source")
              ? [
                  {
                    index,
                    scope: "record" as const,
                    message: "unresolved",
                    retryable: true,
                  },
                ]
              : [],
          ),
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("retry-exhaustion-test");
    const completion = sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(requests).toHaveLength(3));

    await expect(completion).resolves.toMatchObject({
      state: "partial",
      hasUnresolved: true,
    });
    expect(requests[1]).toEqual(["Unresolved source"]);
    expect(requests[2]).toEqual(["Unresolved source"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests).toHaveLength(3);
    expect(document.querySelector("#unresolved")!.textContent).toBe(
      "Unresolved source",
    );
    ctx.notifyInvalidated();
  });

  it("clamps Retry-After before the next record attempt", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<p>Rate-limited source</p>";
    const requestTimes: number[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requestTimes.push(performance.now());
        const retry = requestTimes.length === 1;
        return {
          results: pieces.map((row) =>
            row.map((source) => (retry ? "" : translated("en", source))),
          ),
          failures: retry
            ? [
                {
                  index: 0,
                  scope: "record" as const,
                  message: "rate limited",
                  retryable: true,
                  retryAfterMs: 45_000,
                },
              ]
            : [],
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("retry-after-test");
    const completion = sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });

    await vi.waitFor(() => expect(requestTimes).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(requestTimes).toHaveLength(2));
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(30_000);
    await expect(completion).resolves.toMatchObject({ state: "translated" });
    ctx.notifyInvalidated();
  });

  it("dispatches newly visible work while another record waits to retry", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <p>Retrying source</p>
      <p id="lazy-retry-peer">Lazy peer</p>
    `;
    const lazyElement = document.querySelector("#lazy-retry-peer")!;
    let lazyTop = 5_000;
    vi.spyOn(lazyElement, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: lazyTop,
          top: lazyTop,
          bottom: lazyTop + 20,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const requests: string[][] = [];
    let retryingAttempts = 0;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces.flat());
        const containsRetrying = pieces.some((row) =>
          row.includes("Retrying source"),
        );
        if (containsRetrying) retryingAttempts += 1;
        const failRetrying = containsRetrying && retryingAttempts === 1;
        return {
          results: pieces.map((row) =>
            row.map((source) =>
              source === "Retrying source" && failRetrying
                ? ""
                : translated("en", source),
            ),
          ),
          failures: failRetrying
            ? [
                {
                  index: pieces.findIndex((row) =>
                    row.includes("Retrying source"),
                  ),
                  scope: "record" as const,
                  message: "unresolved",
                  retryable: true,
                },
              ]
            : [],
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("retry-scroll-peer-test");
    const completion = sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual(["Retrying source"]);
    await vi.advanceTimersByTimeAsync(0);
    lazyTop = 0;
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual(["Lazy peer"]);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toEqual(["Retrying source"]);
    await expect(completion).resolves.toMatchObject({ state: "translated" });
    ctx.notifyInvalidated();
  });

  it("keeps accepted DOM and retries only unresolved records in a new generation", async () => {
    document.body.innerHTML = `
        <p id="accepted">Accepted text</p>
        <p id="remaining">Remaining text</p>
        <p id="detached">Remaining detached</p>
        <input id="accepted-attribute" title="Accepted title">
        <input id="remaining-attribute" title="Remaining title">
      `;
    const acceptedNode = document.querySelector("#accepted")!.firstChild!;
    const remainingNode = document.querySelector("#remaining")!.firstChild!;
    const acceptedAttribute = document.querySelector("#accepted-attribute")!;
    const remainingAttribute = document.querySelector("#remaining-attribute")!;
    const requests: string[][] = [];
    const summaries: Record<string, unknown>[] = [];
    let generation = 0;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") {
        generation += 1;
        return { ok: true };
      }
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces.flat());
        return {
          results: pieces.map((row) =>
            row.map((source) =>
              generation === 1 && source.startsWith("Remaining")
                ? ""
                : translated("en", source),
            ),
          ),
          failures: pieces.flatMap((row, index) =>
            generation === 1 &&
            row.some((source) => source.startsWith("Remaining"))
              ? [
                  {
                    index,
                    scope: "record" as const,
                    message: "unresolved",
                    retryable: false,
                  },
                ]
              : [],
          ),
        };
      }
      if (message.type === "TRANSLATE_TEXT") {
        const texts = message.texts as string[];
        requests.push(texts);
        return {
          results: texts.map((source) =>
            generation === 1 && source.startsWith("Remaining")
              ? ""
              : translated("en", source),
          ),
          failures: texts.flatMap((source, index) =>
            generation === 1 && source.startsWith("Remaining")
              ? [
                  {
                    index,
                    scope: "record" as const,
                    message: "unresolved",
                    retryable: false,
                  },
                ]
              : [],
          ),
        };
      }
      if (message.type === "RECORD_TRANSLATION_DIAGNOSTICS") {
        summaries.push(message.summary as Record<string, unknown>);
        return { saved: true };
      }
      return undefined;
    }) as never);
    const ctx = startContent("partial-generation-test");

    const first = await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    expect(first.state).toBe("partial");
    expect(acceptedNode.textContent).toBe("EN:Accepted text");
    expect(remainingNode.textContent).toBe("Remaining text");
    expect(acceptedAttribute.getAttribute("title")).toBe("EN:Accepted title");
    expect(remainingAttribute.getAttribute("title")).toBe("Remaining title");
    const requestBoundary = requests.length;
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(requests).toHaveLength(requestBoundary);
    document.querySelector("#detached")!.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      "<p>New pending mutation</p>",
    );
    await Promise.resolve();

    const second = await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    expect(second.state).toBe("translated");
    expect(document.querySelector("#accepted")!.firstChild).toBe(acceptedNode);
    expect(acceptedNode.textContent).toBe("EN:Accepted text");
    expect(requests.slice(requestBoundary).flat().sort()).toEqual([
      "New pending mutation",
      "Remaining text",
      "Remaining title",
    ]);
    expect(summaries.at(-1)).toMatchObject({
      provider: "openai",
      discoveredRecords: 3,
      eligibleRecords: 3,
      attemptedRecords: 3,
      deterministicRecords: 0,
      localCacheHits: 0,
      localCacheMisses: 0,
      localCacheInvalid: 0,
      providerAccepted: 0,
      providerRejected: 0,
      nativeAttempted: 0,
      nativeAccepted: 0,
      storageReadCalls: 0,
      storageWriteCalls: 0,
      storageReadMs: 0,
      storageWriteMs: 0,
      maxViewportDispatchMs: expect.any(Number),
      maxViewportCommitMs: expect.any(Number),
    });

    await sendContentMessage({ type: "SHOW_ORIGINAL" });
    expect(document.querySelector("#accepted")!.firstChild).toBe(acceptedNode);
    expect(acceptedNode.textContent).toBe("Accepted text");
    expect(remainingNode.textContent).toBe("Remaining text");
    expect(acceptedAttribute.getAttribute("title")).toBe("Accepted title");
    expect(remainingAttribute.getAttribute("title")).toBe("Remaining title");
    ctx.notifyInvalidated();
  });

  it("fully restores before translating a different target", async () => {
    document.body.innerHTML = '<p id="source">Exact source</p>';
    const node = document.querySelector("#source")!.firstChild!;
    const requested: string[][] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requested.push(pieces.flat());
        return {
          results: pieces.map((row) =>
            row.map((source) =>
              translated(message.targetLanguage as string, source),
            ),
          ),
          failures: [],
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("target-change-test");

    await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });

    expect(requested).toEqual([["Exact source"], ["Exact source"]]);
    expect(node.textContent).toBe("VI:Exact source");
    await sendContentMessage({ type: "SHOW_ORIGINAL" });
    expect(node.textContent).toBe("Exact source");
    ctx.notifyInvalidated();
  });

  it("continues lazy first attempts and never resends accepted scroll-back records", async () => {
    document.body.innerHTML = `
        <p id="visible">Visible source</p>
        <p id="lazy">Lazy source</p>
      `;
    const lazyElement = document.querySelector("#lazy")!;
    const lazyNode = lazyElement.firstChild!;
    let lazyTop = 5_000;
    vi.spyOn(lazyElement, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: lazyTop,
          top: lazyTop,
          bottom: lazyTop + 20,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const requests: string[][] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        requests.push(pieces.flat());
        return {
          results: pieces.map((row) =>
            row.map((source) => translated("en", source)),
          ),
          failures: [],
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("lazy-scroll-test");

    const initial = await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    expect(initial.state).toBe("translated");
    expect(requests.flat()).toEqual(["Visible source"]);

    lazyTop = 0;
    await vi.waitFor(() => expect(requests.flat()).toContain("Lazy source"), {
      timeout: 650,
    });
    expect(lazyElement.firstChild).toBe(lazyNode);
    expect(lazyNode.textContent).toBe("EN:Lazy source");
    const requestCount = requests.length;
    lazyTop = 5_000;
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    lazyTop = 0;
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    expect(requests).toHaveLength(requestCount);
    ctx.notifyInvalidated();
  });

  it("routes Japanese native recovery through the shared record resolver", async () => {
    document.body.innerHTML = '<p id="source">設定 Menu</p>';
    const nativeRequests: RuntimeMessage[] = [];
    let providerRequests = 0;
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "en" };
      if (message.type === "TRANSLATE_HTML") {
        providerRequests += 1;
        return {
          results: (message.pieces as string[][]).map((row) =>
            row.map(() => ""),
          ),
          failures: [],
        };
      }
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { progress: { phase: "ready" } };
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        nativeRequests.push(message);
        return {
          runId: message.runId,
          results: (message.texts as string[]).map(() => ({
            status: "accepted",
            text: "Settings Menu",
          })),
        };
      }
      return undefined;
    }) as never);
    const ctx = startContent("native-route-test");

    const result = await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });

    expect(result.state).toBe("translated");
    expect(providerRequests).toBe(3);
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests[0]).toMatchObject({
      sourceLanguage: "ja",
      targetLanguage: "vi",
      texts: ["設定 Menu"],
    });
    ctx.notifyInvalidated();
  });

  it("caches native-accepted Text slots independently of unresolved siblings", async () => {
    document.body.innerHTML =
      '<p id="piece">保存済み<span>回復</span>未解決</p>';
    const piece = document.querySelector("#piece")!;
    const primaryNode = piece.firstChild!;
    const nativeNode = piece.querySelector("span")!.firstChild!;
    const unresolvedNode = piece.lastChild!;
    const cacheMessages: RuntimeMessage[] = [];
    const providerRequests: string[][] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as unknown as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "ja" };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        providerRequests.push(pieces.flat());
        return {
          results: pieces.map((row) =>
            row.map((source) => (source === "保存済み" ? "Saved" : "")),
          ),
          failures: [],
        };
      }
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { progress: { phase: "ready" } };
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        return {
          runId: message.runId,
          results: (message.texts as string[]).map((source) =>
            source === "回復"
              ? { status: "accepted", text: "Recovered" }
              : { status: "error", reason: "unresolved" },
          ),
        };
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK") {
        cacheMessages.push(message);
        return { saved: 1 };
      }
      return undefined;
    }) as never);
    const ctx = startContent("native-slot-cache-test");

    const result = await sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });

    expect(result.state).toBe("partial");
    expect(providerRequests).toEqual([
      ["保存済み", "回復", "未解決"],
      ["回復", "未解決"],
      ["回復", "未解決"],
    ]);
    expect(primaryNode.textContent).toBe("Saved");
    expect(nativeNode.textContent).toBe("Recovered");
    expect(unresolvedNode.textContent).toBe("未解決");
    expect(cacheMessages).toHaveLength(1);
    expect(cacheMessages[0]).toMatchObject({
      type: "CACHE_ACCEPTED_OPENAI_FALLBACK",
      targetLanguage: "en",
      sources: [["回復"]],
      results: [["Recovered"]],
      provenance: "browser-native",
    });
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(piece.firstChild).toBe(primaryNode);
    expect(piece.querySelector("span")!.firstChild).toBe(nativeNode);
    expect(nativeNode.textContent).toBe("Recovered");
    expect(unresolvedNode.textContent).toBe("未解決");
    expect(cacheMessages).toHaveLength(1);
    ctx.notifyInvalidated();
  });

  it("caches backend Google results in the chain and sends only backend-unresolved records once to native", async () => {
    document.body.innerHTML = `
        <p id="google">保存</p>
        <p id="native">回復</p>
        <p id="auto">Plain source</p>
      `;
    const primaryRequests: string[][] = [];
    const nativeRequests: string[][] = [];
    const cacheMessages: RuntimeMessage[] = [];
    const messages: RuntimeMessage[] = [];
    const summaries: Record<string, unknown>[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as RuntimeMessage;
      messages.push(message);
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        primaryRequests.push(pieces.flat());
        // The backend already ran OpenAI retries and its Google fallback.
        const results = pieces.map((row) =>
          row.map((source) => (source === "保存" ? "Saved by Google" : "")),
        );
        return {
          results,
          cacheableResults: results,
          provenance: pieces.map((row) =>
            row.map((source) => (source === "保存" ? "google" : undefined)),
          ),
          failures: pieces.flatMap((row, index) =>
            row.includes("保存")
              ? []
              : [
                  {
                    index,
                    scope: "record" as const,
                    message: "unresolved",
                    retryable: false,
                  },
                ],
          ),
        };
      }
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { progress: { phase: "ready" } };
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        const texts = message.texts as string[];
        nativeRequests.push(texts);
        return {
          runId: message.runId,
          results: texts.map(() => ({
            status: "accepted" as const,
            text: "Recovered natively",
          })),
        };
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK") {
        cacheMessages.push(message);
        return { saved: 1 };
      }
      if (message.type === "RECORD_TRANSLATION_DIAGNOSTICS") {
        summaries.push(message.summary as Record<string, unknown>);
        return { saved: true };
      }
      return undefined;
    }) as never);
    const ctx = startContent("backend-fallback-chain-test");
    await expect(
      sendContentMessage({ type: "START_TRANSLATION", targetLanguage: "en" }),
    ).resolves.toMatchObject({ state: "partial", hasUnresolved: true });

    expect(primaryRequests).toEqual([["保存", "回復", "Plain source"]]);
    expect(nativeRequests).toEqual([["回復"]]);
    expect(messages.some((message) => /GOOGLE/.test(message.type))).toBe(false);
    expect(document.querySelector("#google")!.textContent).toBe(
      "Saved by Google",
    );
    expect(document.querySelector("#native")!.textContent).toBe(
      "Recovered natively",
    );
    expect(document.querySelector("#auto")!.textContent).toBe("Plain source");
    expect(cacheMessages).toEqual([
      expect.objectContaining({
        provenance: "google",
        sources: [["保存"]],
        results: [["Saved by Google"]],
      }),
      expect.objectContaining({
        provenance: "browser-native",
        sources: [["回復"]],
        results: [["Recovered natively"]],
      }),
    ]);
    expect(
      messages.filter(
        (message) => message.type === "CACHE_ACCEPTED_OPENAI_HTML",
      ),
    ).toEqual([]);
    expect(summaries.at(-1)).toMatchObject({
      chainCacheHits: 0,
      googleFallbackAccepted: 1,
      nativeAttempted: 1,
      nativeAccepted: 1,
    });
    // A settled run with accepted results names only its applied target for
    // the content-free `file_translated` product event (ADR 0017).
    const diagnostics = messages.filter(
      (message) => message.type === "RECORD_TRANSLATION_DIAGNOSTICS",
    );
    expect(diagnostics.at(-1)).toMatchObject({ appliedTargetLanguage: "en" });
    expect(Object.keys(diagnostics.at(-1)!).sort()).toEqual([
      "appliedTargetLanguage",
      "runId",
      "summary",
      "type",
    ]);
    ctx.notifyInvalidated();
  });

  it("never caches a detached native result after a terminal backend failure", async () => {
    document.body.innerHTML = '<p id="source">未解決</p>';
    let resolveNative!: (value: Record<string, unknown>) => void;
    let nativeRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      nativeRequested = resolve;
    });
    const cacheMessages: RuntimeMessage[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN") return { ok: true };
      if (message.type === "TRANSLATE_HTML")
        return {
          results: [[""]],
          failures: [
            {
              index: 0,
              scope: "record" as const,
              message: "configuration failure",
              retryable: false,
            },
          ],
        };
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { progress: { phase: "ready" } };
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        nativeRequested();
        return await new Promise((resolve) => {
          resolveNative = resolve;
        });
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK") {
        cacheMessages.push(message);
        return { saved: 1 };
      }
      return undefined;
    }) as never);
    const ctx = startContent("backend-terminal-failure-test");
    const completion = sendContentMessage({
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });

    await requested;
    document.querySelector("#source")!.remove();
    resolveNative({
      runId: 1,
      results: [{ status: "accepted", text: "Recovered too late" }],
    });
    await completion;

    expect(cacheMessages).toEqual([]);
    ctx.notifyInvalidated();
  });

  it("routes queued records only to native after a run-scoped backend failure", async () => {
    const sources = Array.from(
      { length: 260 },
      (_, index) => `項目 ${String(index).padStart(3, "0")}`,
    );
    document.body.innerHTML = sources
      .map((source, index) => `<p id="queued-${index}">${source}</p>`)
      .join("");
    const stages: string[] = [];
    const openAiRequests: string[][] = [];
    const nativeRequests: string[][] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      rawMessage: unknown,
    ) => {
      const message = rawMessage as RuntimeMessage;
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "ja" };
      if (message.type === "TRANSLATE_HTML") {
        stages.push("openai");
        const pieces = message.pieces as string[][];
        openAiRequests.push(pieces.flat());
        return {
          results: pieces.map((row) => row.map(() => "")),
          failures: [
            {
              index: 0,
              scope: "run" as const,
              message: "HTTP 401",
              retryable: false,
            },
          ],
        };
      }
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { progress: { phase: "ready" } };
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        stages.push("native");
        const texts = message.texts as string[];
        nativeRequests.push(texts);
        return {
          runId: message.runId,
          results: texts.map((source) => ({
            status: "accepted" as const,
            text: `NATIVE:${source}`,
          })),
        };
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK")
        return { saved: (message.sources as string[][]).length };
      return undefined;
    }) as never);
    const ctx = startContent("run-failure-fallback-queue-test");

    await expect(
      sendContentMessage({ type: "START_TRANSLATION", targetLanguage: "en" }),
    ).resolves.toMatchObject({ state: "translated", hasUnresolved: false });

    expect(openAiRequests.length).toBeGreaterThan(0);
    expect(openAiRequests.flat().length).toBeLessThan(sources.length);
    expect(stages.slice(stages.indexOf("native") + 1)).not.toContain("openai");
    expect(nativeRequests.flat().sort()).toEqual([...sources].sort());
    sources.forEach((source, index) => {
      expect(document.querySelector(`#queued-${index}`)!.textContent).toBe(
        `NATIVE:${source}`,
      );
    });
    ctx.notifyInvalidated();
  }, 15_000);
});
