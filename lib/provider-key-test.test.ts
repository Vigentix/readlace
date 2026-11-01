import { describe, expect, it, vi } from "vitest";
import { testOpenAIKey } from "./provider-key-test";

const KEY = "sk-test-key-0123456789abcdef";

function fetchReturning(status: number) {
  return vi.fn<typeof fetch>(async () => new Response("{}", { status }));
}

describe("testOpenAIKey", () => {
  it("asks for the chosen model with the key as a bearer token", async () => {
    const fetchImpl = fetchReturning(200);
    expect(await testOpenAIKey(KEY, "gpt-5-nano", fetchImpl)).toBe("valid");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models/gpt-5-nano");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    expect(init?.method).toBe("GET");
  });

  it("maps provider answers to outcomes without reading the body", async () => {
    expect(await testOpenAIKey(KEY, "gpt-5", fetchReturning(401))).toBe(
      "invalid-key",
    );
    expect(await testOpenAIKey(KEY, "gpt-5", fetchReturning(403))).toBe(
      "invalid-key",
    );
    expect(await testOpenAIKey(KEY, "gpt-5", fetchReturning(404))).toBe(
      "model-unavailable",
    );
    expect(await testOpenAIKey(KEY, "gpt-5", fetchReturning(429))).toBe(
      "rate-limited",
    );
    expect(await testOpenAIKey(KEY, "gpt-5", fetchReturning(503))).toBe(
      "unreachable",
    );
  });

  it("reports a network failure as unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await testOpenAIKey(KEY, "gpt-5", fetchImpl)).toBe("unreachable");
  });
});
