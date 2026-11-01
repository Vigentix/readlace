import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ContentScriptContext } from "wxt/utils/content-script-context";

import contentScript from "@/entrypoints/content";

// ADR 0011/0014: a Free run follows the background path selector. Saved
// translations still apply; cache misses go once to the existing per-record
// on-device stage (text, attributes and title) with no backend retry.
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

const originalBoundingClientRect = Element.prototype.getBoundingClientRect;
const unresolved = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    index,
    scope: "record",
    message: "Not sent to the backend: on-device path",
    retryable: false,
  }));

describe("content Free on-device path", () => {
  beforeEach(() => {
    document.documentElement.innerHTML =
      "<head><title>請求一覧</title></head><body></body>";
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
    vi.unstubAllGlobals();
  });

  it("translates text, attributes and the title on-device once each and caches them as browser-native", async () => {
    document.body.innerHTML =
      '<p id="saved">保存済み</p><p id="text">請求書</p><img id="image" alt="画像" src="data:,">';
    const messages: RuntimeMessage[] = [];
    let releaseNative: (() => void) | undefined;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      messages.push(message);
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "ja", path: "native" };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        // Saved translations still apply on the native path.
        const results = pieces.map((row) =>
          row.map((source) => (source === "保存済み" ? "Saved" : "")),
        );
        return {
          results,
          path: "native",
          failures: unresolved(pieces.length).filter(
            (_, index) => !results[index]!.some(Boolean),
          ),
        };
      }
      if (message.type === "TRANSLATE_TEXT") {
        const texts = message.texts as string[];
        return {
          results: texts.map(() => ""),
          path: "native",
          failures: unresolved(texts.length),
        };
      }
      if (message.type === "TRANSLATE_SINGLE")
        return { text: "", path: "native" };
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return {
          availability: "available",
          ready: true,
          progress: { phase: "ready" },
        };
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        await nativeGate;
        return {
          runId: message.runId,
          results: (message.texts as string[]).map((source) => ({
            status: "accepted",
            text: `VI:${source}`,
          })),
        };
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK")
        return { saved: 1 };
      if (message.type === "AUTHORIZE_TRANSLATION_COMMIT")
        return { ok: true, runId: message.runId };
      return undefined;
    }) as never);
    const ctx = startContent("free-native-path");
    try {
      const run = sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      });
      await vi.waitFor(() =>
        expect(
          messages.some((message) => message.type === "TRANSLATE_NATIVE_TEXT"),
        ).toBe(true),
      );
      // A prepared session is the translation itself: "translating", not
      // the first-use "preparing" state.
      await expect(
        sendContentMessage({ type: "CONTENT_STATE" }),
      ).resolves.toMatchObject({
        state: "translating",
        translationPath: "native",
      });
      releaseNative?.();
      const result = await run;

      expect(result.state).toBe("translated");
      expect(document.querySelector("#saved")!.textContent).toBe("Saved");
      expect(document.querySelector("#text")!.textContent).toBe("VI:請求書");
      expect(document.querySelector("#image")!.getAttribute("alt")).toBe(
        "VI:画像",
      );
      expect(document.title).toBe("VI:請求一覧");
      const nativeTexts = messages
        .filter((message) => message.type === "TRANSLATE_NATIVE_TEXT")
        .flatMap((message) => message.texts as string[]);
      expect(nativeTexts.sort()).toEqual(["画像", "請求一覧", "請求書"].sort());
      // No backend retries on the native path: one request per record.
      expect(
        messages
          .filter((message) => message.type === "TRANSLATE_HTML")
          .flatMap((message) => (message.pieces as string[][]).flat())
          .sort(),
      ).toEqual(["保存済み", "請求書"].sort());
      const cached = messages
        .filter((message) => message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK")
        .map((message) => ({
          provenance: message.provenance,
          sources: (message.sources as string[][]).flat(),
        }));
      expect(
        cached.every((entry) => entry.provenance === "browser-native"),
      ).toBe(true);
      expect(cached.flatMap((entry) => entry.sources).sort()).toEqual(
        ["画像", "請求一覧", "請求書"].sort(),
      );
      // Show original restores exactly.
      await sendContentMessage({ type: "SHOW_ORIGINAL" });
      expect(document.querySelector("#text")!.textContent).toBe("請求書");
      expect(document.title).toBe("請求一覧");
    } finally {
      ctx.notifyInvalidated();
    }
  });

  it("makes no on-device attempt on the unavailable path and settles truthfully", async () => {
    document.body.innerHTML = '<p id="text">請求書</p>';
    const messages: RuntimeMessage[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      messages.push(message);
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "ja", path: "unavailable" };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        return {
          results: pieces.map((row) => row.map(() => "")),
          path: "unavailable",
          failures: unresolved(pieces.length),
        };
      }
      if (message.type === "TRANSLATE_SINGLE")
        return { text: "", path: "unavailable" };
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return {
          availability: "unavailable",
          ready: false,
          progress: { phase: "checking" },
        };
      return undefined;
    }) as never);
    const ctx = startContent("free-unavailable-path");
    try {
      const result = await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      });
      expect(result.state).toBe("error");
      await expect(
        sendContentMessage({ type: "CONTENT_STATE" }),
      ).resolves.toMatchObject({
        state: "error",
        translationPath: "unavailable",
      });
      expect(document.querySelector("#text")!.textContent).toBe("請求書");
      expect(
        messages.some((message) => message.type === "TRANSLATE_NATIVE_TEXT"),
      ).toBe(false);
      expect(
        messages.filter((message) => message.type === "TRANSLATE_HTML"),
      ).toHaveLength(1);
    } finally {
      ctx.notifyInvalidated();
    }
  });

  it("follows a mid-run switch to native after a backend refusal", async () => {
    document.body.innerHTML = '<p id="text">請求書</p>';
    const messages: RuntimeMessage[] = [];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation((async (
      raw: unknown,
    ) => {
      const message = raw as RuntimeMessage;
      messages.push(message);
      if (message.type === "BEGIN_TRANSLATION_RUN")
        return { ok: true, sourceLanguageHint: "ja", path: "backend" };
      if (message.type === "TRANSLATE_HTML") {
        const pieces = message.pieces as string[][];
        // ENTITLEMENT_REQUIRED left the records unresolved; later work is native.
        return {
          results: pieces.map((row) => row.map(() => "")),
          path: "native",
          failures: pieces.map((_, index) => ({
            index,
            scope: "record",
            message: "Invalid provider response: unresolved translation",
            retryable: false,
          })),
        };
      }
      if (message.type === "TRANSLATE_SINGLE")
        return { text: "", path: "native" };
      if (message.type === "PREPARE_NATIVE_TRANSLATOR")
        return { ready: true, progress: { phase: "ready" } };
      if (message.type === "TRANSLATE_NATIVE_TEXT")
        return {
          runId: message.runId,
          results: (message.texts as string[]).map((source) => ({
            status: "accepted",
            text: `VI:${source}`,
          })),
        };
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK")
        return { saved: 1 };
      return undefined;
    }) as never);
    const ctx = startContent("refusal-switch-path");
    try {
      const result = await sendContentMessage({
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      });
      expect(result.state).toBe("translated");
      await expect(
        sendContentMessage({ type: "CONTENT_STATE" }),
      ).resolves.toMatchObject({ translationPath: "native" });
      expect(document.querySelector("#text")!.textContent).toBe("VI:請求書");
      expect(result).not.toHaveProperty("error");
    } finally {
      ctx.notifyInvalidated();
    }
  });
});
