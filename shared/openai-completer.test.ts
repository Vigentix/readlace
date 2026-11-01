// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompleter } from "./openai-completer";
import {
  TEST_PROVIDER_KEY,
  openAIResponsesBody,
} from "@/tests/fixtures/openai-responses";

describe("createOpenAiCompleter", () => {
  it("calls OpenAI directly with the user's key and chosen model", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(openAIResponsesBody({ r0: "Hello" }, "gpt-5-mini")),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const complete = createOpenAiCompleter(
      TEST_PROVIDER_KEY,
      fetchImpl,
      "gpt-5-mini",
    );
    const usage = vi.fn();
    expect(
      await complete({ r0: "こんにちは" }, { r0: "ja" }, "en", usage),
    ).toEqual({
      r0: "Hello",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${TEST_PROVIDER_KEY}`,
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5-mini",
    });
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
    );
  });
});
