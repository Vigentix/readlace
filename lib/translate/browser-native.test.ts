import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_TRANSLATE_CONCURRENCY,
  createNativeTranslatorHost,
  prepareNativeTranslator,
  type NativeRecoveryAvailability,
  type NativeRecoveryProgress,
} from "./browser-native";

interface FakeCreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  signal: AbortSignal;
  monitor(monitor: {
    addEventListener(
      type: "downloadprogress",
      listener: (event: { loaded: number; total: number }) => void,
    ): void;
  }): void;
}

function fakeTranslator(availability: NativeRecoveryAvailability) {
  const destroy = vi.fn();
  const translate = vi.fn(async (text: string) =>
    text === "請求" ? "Invoice" : text,
  );
  let progress:
    ((event: { loaded: number; total: number }) => void) | undefined;
  const factory = {
    availability: vi.fn(
      async (options: { sourceLanguage: string; targetLanguage: string }) => {
        void options;
        return availability;
      },
    ),
    create: vi.fn(async (options: FakeCreateOptions) => {
      options.monitor({
        addEventListener(_type, listener) {
          progress = listener;
        },
      });
      progress?.({ loaded: 0.5, total: 1 });
      return { translate, destroy };
    }),
  };
  vi.stubGlobal("Translator", factory);
  return { factory, translate, destroy };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prepareNativeTranslator", () => {
  it("returns unavailable when the feature or pair is unavailable", async () => {
    const progress: NativeRecoveryProgress[] = [];
    const signal = new AbortController().signal;

    expect(
      await prepareNativeTranslator(
        "ja",
        "en",
        (event) => progress.push(event),
        signal,
      ),
    ).toBeNull();
    expect(progress).toEqual([{ phase: "checking" }]);

    const { factory } = fakeTranslator("unavailable");
    expect(
      await prepareNativeTranslator("ja", "en", vi.fn(), signal),
    ).toBeNull();
    expect(factory.availability).toHaveBeenCalledWith({
      sourceLanguage: "ja",
      targetLanguage: "en",
    });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it.each(["downloadable", "downloading"] as const)(
    "normalizes %s preparation and download progress",
    async (availability) => {
      const { factory } = fakeTranslator(availability);
      const progress: NativeRecoveryProgress[] = [];
      const controller = new AbortController();

      const session = await prepareNativeTranslator(
        "ja",
        "vi",
        (event) => progress.push(event),
        controller.signal,
      );

      expect(session).not.toBeNull();
      expect(progress).toEqual([
        { phase: "checking" },
        { phase: "downloading" },
        { phase: "downloading", loaded: 0.5, total: 1 },
        { phase: "ready" },
      ]);
      expect(factory.create.mock.calls[0]?.[0]).toMatchObject({
        sourceLanguage: "ja",
        targetLanguage: "vi",
        signal: controller.signal,
      });
    },
  );

  it("skips download progress when the pair is already available", async () => {
    fakeTranslator("available");
    const progress: NativeRecoveryProgress[] = [];

    expect(
      await prepareNativeTranslator(
        "ja",
        "en",
        (event) => progress.push(event),
        new AbortController().signal,
      ),
    ).not.toBeNull();
    expect(progress).toEqual([
      { phase: "checking" },
      { phase: "downloading", loaded: 0.5, total: 1 },
      { phase: "ready" },
    ]);
  });

  it("accepts only source-aware valid output", async () => {
    const { translate } = fakeTranslator("available");
    const session = await prepareNativeTranslator(
      "ja",
      "en",
      vi.fn(),
      new AbortController().signal,
    );
    const signal = new AbortController().signal;

    await expect(session?.translate("請求", signal)).resolves.toEqual({
      status: "accepted",
      text: "Invoice",
    });
    translate.mockResolvedValueOnce("請求");
    await expect(session?.translate("請求", signal)).resolves.toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    translate.mockResolvedValueOnce("   ");
    await expect(session?.translate("請求", signal)).resolves.toEqual({
      status: "quality-miss",
      reason: "empty",
    });
  });

  it("normalizes availability, creation, translation, and abort failures", async () => {
    vi.stubGlobal("Translator", {
      availability: vi.fn().mockRejectedValue(new Error("availability failed")),
    });
    await expect(
      prepareNativeTranslator(
        "ja",
        "en",
        vi.fn(),
        new AbortController().signal,
      ),
    ).resolves.toBeNull();

    vi.stubGlobal("Translator", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockRejectedValue(new Error("create failed")),
    });
    await expect(
      prepareNativeTranslator(
        "ja",
        "en",
        vi.fn(),
        new AbortController().signal,
      ),
    ).resolves.toBeNull();

    const { translate } = fakeTranslator("available");
    translate.mockRejectedValueOnce(new Error("translate failed"));
    const session = await prepareNativeTranslator(
      "ja",
      "en",
      vi.fn(),
      new AbortController().signal,
    );
    await expect(
      session?.translate("請求", new AbortController().signal),
    ).resolves.toEqual({ status: "error", reason: "translation-failed" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(session?.translate("請求", aborted.signal)).resolves.toEqual({
      status: "error",
      reason: "aborted",
    });
  });

  it("honors preparation abort and destroys a session once", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(
      await prepareNativeTranslator("ja", "en", vi.fn(), alreadyAborted.signal),
    ).toBeNull();

    const { destroy } = fakeTranslator("available");
    const controller = new AbortController();
    const session = await prepareNativeTranslator(
      "ja",
      "en",
      vi.fn(),
      controller.signal,
    );
    session?.destroy();
    session?.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(
      session?.translate("請求", new AbortController().signal),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "session-destroyed",
    });
  });

  it("settles a stalled browser create as unavailable after 30 seconds", async () => {
    vi.useFakeTimers();
    let createSignal: AbortSignal | undefined;
    const factory = {
      availability: vi.fn().mockResolvedValue("downloadable"),
      create: vi.fn((options: FakeCreateOptions) => {
        createSignal = options.signal;
        options.monitor({ addEventListener: vi.fn() });
        return new Promise<never>(() => undefined);
      }),
    };
    vi.stubGlobal("Translator", factory);
    const host = createNativeTranslatorHost();
    const message = {
      type: "PREPARE_NATIVE_TRANSLATOR" as const,
      sourceLanguage: "ja" as const,
      targetLanguage: "en" as const,
    };

    const preparing = host.prepare(message);
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(preparing).resolves.toEqual({
      availability: "unavailable",
      ready: false,
      progress: { phase: "checking" },
    });
    expect(createSignal?.aborted).toBe(true);
    expect(
      host.query({
        type: "QUERY_NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "en",
      }),
    ).toEqual({
      availability: "unavailable",
      ready: false,
      progress: { phase: "checking" },
    });
  });

  it("restarts the no-progress watchdog only when download progress changes", async () => {
    vi.useFakeTimers();
    let reportProgress:
      ((event: { loaded: number; total: number }) => void) | undefined;
    vi.stubGlobal("Translator", {
      availability: vi.fn().mockResolvedValue("downloadable"),
      create: vi.fn((options: FakeCreateOptions) => {
        options.monitor({
          addEventListener(_type, listener) {
            reportProgress = listener;
          },
        });
        return new Promise<never>(() => undefined);
      }),
    });
    const progress: NativeRecoveryProgress[] = [];
    let settled = false;
    const preparing = prepareNativeTranslator(
      "ja",
      "en",
      (event) => progress.push(event),
      new AbortController().signal,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(reportProgress).toBeTypeOf("function"));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    reportProgress?.({ loaded: 0.25, total: 1 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    reportProgress?.({ loaded: 0.5, total: 1 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(preparing).resolves.toBeNull();
    expect(progress).toEqual([
      { phase: "checking" },
      { phase: "downloading" },
      { phase: "downloading", loaded: 0.25, total: 1 },
      { phase: "downloading", loaded: 0.5, total: 1 },
      { phase: "checking" },
    ]);
  });
});

describe("createNativeTranslatorHost", () => {
  it("shares and deduplicates pair preparation while keeping pairs independent", async () => {
    const { factory, destroy, translate } = fakeTranslator("available");
    factory.availability.mockImplementation(async ({ targetLanguage }) =>
      targetLanguage === "ja" ? "unavailable" : "available",
    );
    const host = createNativeTranslatorHost();
    const english = {
      type: "PREPARE_NATIVE_TRANSLATOR" as const,
      sourceLanguage: "ja" as const,
      targetLanguage: "en" as const,
    };

    await expect(host.prepare(english)).resolves.toMatchObject({
      availability: "available",
      ready: true,
      progress: { phase: "ready" },
    });
    await expect(host.prepare(english)).resolves.toMatchObject({ ready: true });
    expect(
      host.query({
        type: "QUERY_NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "en",
      }),
    ).toMatchObject({ availability: "available", ready: true });
    expect(factory.create).toHaveBeenCalledTimes(1);
    await expect(
      host.translate("1:0:doc:1", "1:0:doc", {
        type: "TRANSLATE_NATIVE_TEXT",
        runId: 1,
        sourceLanguage: "ja",
        targetLanguage: "en",
        texts: ["請求", "請求月"],
      }),
    ).resolves.toEqual({
      runId: 1,
      results: [
        { status: "accepted", text: "Invoice" },
        { status: "quality-miss", reason: "source-identical" },
      ],
    });
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      "請求",
      "請求月",
    ]);

    await expect(
      host.prepare({ ...english, targetLanguage: "vi" }),
    ).resolves.toMatchObject({ availability: "available", ready: true });
    expect(factory.create).toHaveBeenCalledTimes(2);

    const unavailable = { ...english, targetLanguage: "ja" as const };
    await expect(host.prepare(unavailable)).resolves.toMatchObject({
      availability: "unavailable",
      ready: false,
    });
    await host.prepare(unavailable);
    expect(factory.availability).toHaveBeenCalledTimes(3);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent preparation and exposes its pair progress", async () => {
    const destroy = vi.fn();
    const translate = vi.fn(async () => "Invoice");
    let resolveCreate:
      | ((session: {
          translate: typeof translate;
          destroy: typeof destroy;
        }) => void)
      | undefined;
    const factory = {
      availability: vi.fn().mockResolvedValue("downloadable"),
      create: vi.fn((options: FakeCreateOptions) =>
        options.targetLanguage === "vi"
          ? Promise.resolve({ translate, destroy })
          : new Promise<{
              translate: typeof translate;
              destroy: typeof destroy;
            }>((resolve) => {
              resolveCreate = resolve;
            }),
      ),
    };
    vi.stubGlobal("Translator", factory);
    const host = createNativeTranslatorHost();
    const message = {
      type: "PREPARE_NATIVE_TRANSLATOR" as const,
      sourceLanguage: "ja" as const,
      targetLanguage: "en" as const,
    };

    const popup = host.prepare(message);
    const content = host.prepare(message);
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledTimes(1));
    await expect(
      host.prepare({ ...message, targetLanguage: "vi" }),
    ).resolves.toMatchObject({ availability: "available", ready: true });
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(
      host.query({
        type: "QUERY_NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "en",
      }),
    ).toMatchObject({ availability: "downloading", ready: false });
    resolveCreate?.({ translate, destroy });
    await expect(Promise.all([popup, content])).resolves.toEqual([
      {
        availability: "available",
        ready: true,
        progress: { phase: "ready" },
      },
      {
        availability: "available",
        ready: true,
        progress: { phase: "ready" },
      },
    ]);
  });

  it("scopes stale and explicit cancellation to requests, not the warm pair", async () => {
    const destroy = vi.fn();
    const signals: AbortSignal[] = [];
    const translate = vi.fn(
      (_text: string, { signal }: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("Translator", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({ translate, destroy }),
    });
    const host = createNativeTranslatorHost();
    await host.prepare({
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja",
      targetLanguage: "en",
    });
    const message = (runId: number) => ({
      type: "TRANSLATE_NATIVE_TEXT" as const,
      runId,
      sourceLanguage: "ja" as const,
      targetLanguage: "en" as const,
      texts: ["請求"],
    });

    const stale = host.translate("1:0:doc-a:1", "1:0:doc-a", message(1));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const otherTab = host.translate("2:0:doc-b:1", "2:0:doc-b", message(1));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const current = host.translate("1:0:doc-a:2", "1:0:doc-a", message(2));
    await vi.waitFor(() => expect(signals).toHaveLength(3));

    await expect(stale).resolves.toEqual({
      runId: 1,
      results: [{ status: "error", reason: "aborted" }],
    });
    expect(signals[1]?.aborted).toBe(false);
    expect(host.cancel("1:0:doc-a:2")).toBe(true);
    await expect(current).resolves.toEqual({
      runId: 2,
      results: [{ status: "error", reason: "aborted" }],
    });
    expect(signals[1]?.aborted).toBe(false);
    host.clearOwner("2:0:doc-b");
    await expect(otherTab).resolves.toEqual({
      runId: 1,
      results: [{ status: "error", reason: "aborted" }],
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(
      host.query({
        type: "QUERY_NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "en",
      }),
    ).toMatchObject({ availability: "available", ready: true });
  });

  it("pipelines one prepared session with bounded concurrency and keeps result order", async () => {
    const pending: { text: string; resolve: (value: string) => void }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const translate = vi.fn(
      (text: string) =>
        new Promise<string>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push({
            text,
            resolve: (value) => {
              inFlight -= 1;
              resolve(value);
            },
          });
        }),
    );
    const factory = {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({ translate, destroy: vi.fn() }),
    };
    vi.stubGlobal("Translator", factory);
    const host = createNativeTranslatorHost();
    await host.prepare({
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja",
      targetLanguage: "en",
    });
    const texts = Array.from({ length: 10 }, (_, index) => `請求${index}`);
    const message = (runId: number, values: string[]) => ({
      type: "TRANSLATE_NATIVE_TEXT" as const,
      runId,
      sourceLanguage: "ja" as const,
      targetLanguage: "en" as const,
      texts: values,
    });
    // Two concurrent requests (content batches/frames) share one pair budget.
    const first = host.translate("1:0:a:1", "1:0:a", message(1, texts));
    const second = host.translate("1:1:b:1", "1:1:b", message(1, ["請求x"]));
    await vi.waitFor(() =>
      expect(pending).toHaveLength(NATIVE_TRANSLATE_CONCURRENCY),
    );
    // Settle out of order; results still align with their sources.
    while (pending.length || translate.mock.calls.length < 11) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      const call = pending.pop()!;
      call.resolve(`Invoice ${call.text.slice(2)}`);
    }
    await expect(first).resolves.toEqual({
      runId: 1,
      results: texts.map((_, index) => ({
        status: "accepted",
        text: `Invoice ${index}`,
      })),
    });
    await expect(second).resolves.toEqual({
      runId: 1,
      results: [{ status: "accepted", text: "Invoice x" }],
    });
    expect(factory.create).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledTimes(11);
    expect(maxInFlight).toBe(NATIVE_TRANSLATE_CONCURRENCY);
  });

  it("reports first-use download progress for the prepared pair", async () => {
    fakeTranslator("downloadable");
    const onProgress = vi.fn();
    const host = createNativeTranslatorHost({ onProgress });
    await host.prepare({
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja",
      targetLanguage: "vi",
    });
    expect(onProgress.mock.calls).toEqual([
      ["ja", "vi", { phase: "checking" }],
      ["ja", "vi", { phase: "downloading" }],
      ["ja", "vi", { phase: "downloading", loaded: 0.5, total: 1 }],
      ["ja", "vi", { phase: "ready" }],
    ]);
  });

  it("recreates a warm browser-managed session after worker restart", async () => {
    const destroy = vi.fn();
    const translate = vi.fn(async () => "Invoice");
    const factory = {
      availability: vi
        .fn()
        .mockResolvedValueOnce("downloadable")
        .mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({ translate, destroy }),
    };
    vi.stubGlobal("Translator", factory);
    const message = {
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja" as const,
      targetLanguage: "en" as const,
    } as const;

    await createNativeTranslatorHost().prepare(message);
    const restartedHost = createNativeTranslatorHost();
    await expect(restartedHost.prepare(message)).resolves.toMatchObject({
      availability: "available",
      ready: true,
    });
    expect(factory.availability).toHaveBeenNthCalledWith(2, {
      sourceLanguage: "ja",
      targetLanguage: "en",
    });
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
  });
});
