import { describe, expect, it, vi } from "vitest";
import { createByokStage } from "./byok-stage";

const credentials = {
  apiKey: "sk-test-key-0123456789abcdef",
  model: "gpt-5-mini",
};

describe("createByokStage", () => {
  it("translates through the user's key and model and reports provenance", async () => {
    const createCompleter = vi.fn(() =>
      vi.fn(async (sources: Record<string, string>) =>
        Object.fromEntries(
          Object.keys(sources).map((id) => [id, `T:${sources[id]}`]),
        ),
      ),
    );
    const stage = createByokStage({
      readCredentials: async () => credentials,
      createCompleter,
      sleep: async () => undefined,
    });
    const onProvenance = vi.fn();
    const result = await stage(
      { a: "こんにちは", b: "請求管理" },
      { a: "ja", b: "ja" },
      "en",
      undefined,
      onProvenance,
    );
    expect(createCompleter).toHaveBeenCalledWith(
      credentials.apiKey,
      credentials.model,
    );
    expect(result).toEqual({ a: "T:こんにちは", b: "T:請求管理" });
    expect(onProvenance).toHaveBeenCalledWith({ a: "openai", b: "openai" });
  });

  it("returns every record unresolved when no key is configured", async () => {
    const createCompleter = vi.fn();
    const stage = createByokStage({
      readCredentials: async () => undefined,
      createCompleter,
    });
    expect(await stage({ a: "x" }, { a: "ja" }, "en")).toEqual({ a: "" });
    expect(createCompleter).not.toHaveBeenCalled();
  });

  it("reports a rejected key once and makes no retry", async () => {
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    });
    const onKeyRejected = vi.fn();
    const stage = createByokStage({
      readCredentials: async () => credentials,
      createCompleter: () => complete,
      sleep: async () => undefined,
      onKeyRejected,
    });
    expect(await stage({ a: "x" }, { a: "ja" }, "en")).toEqual({ a: "" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onKeyRejected).toHaveBeenCalledWith(401);
  });

  it("retries a rate limit within the stage, then leaves the record for on-device", async () => {
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("Too many"), { statusCode: 429 });
    });
    const sleep = vi.fn(async () => undefined);
    const onKeyRejected = vi.fn();
    const stage = createByokStage({
      readCredentials: async () => credentials,
      createCompleter: () => complete,
      sleep,
      onKeyRejected,
    });
    expect(await stage({ a: "x" }, { a: "ja" }, "en")).toEqual({ a: "" });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onKeyRejected).not.toHaveBeenCalled();
  });

  it("forwards token usage", async () => {
    const stage = createByokStage({
      readCredentials: async () => credentials,
      createCompleter: () => async (_sources, _routes, _target, onUsage) => {
        onUsage?.({ inputTokens: 7, outputTokens: 3 });
        return { r0: "Hello" };
      },
    });
    const onUsage = vi.fn();
    await stage({ a: "こんにちは" }, { a: "ja" }, "en", onUsage);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 7, outputTokens: 3 }),
    );
  });

  it("ends the stage as a run failure on a non-retryable provider error", async () => {
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("Bad request"), { statusCode: 400 });
    });
    const stage = createByokStage({
      readCredentials: async () => credentials,
      createCompleter: () => complete,
      sleep: async () => undefined,
    });
    await expect(stage({ a: "x" }, { a: "ja" }, "en")).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
