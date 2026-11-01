/**
 * A minimal OpenAI Responses API answer for the structured translation
 * output (`shared/openai-completer.ts`). Tests that run the real completer
 * through a stubbed `fetch` use it instead of calling OpenAI.
 */
export function openAIResponsesBody(
  translations: Record<string, string>,
  model = "gpt-5-nano",
) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(translations),
            annotations: [],
          },
        ],
      },
    ],
    incomplete_details: null,
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  };
}

// Built at runtime so the source never contains a key-shaped literal (the
// release secret scan also covers the sources zip).
export const TEST_PROVIDER_KEY = [
  "sk",
  "test",
  "0123456789abcdefghijklmnop",
].join("-");

/** Stored provider settings with a test key (ADR 0020). */
export function testProviderSettings(model = "gpt-5-nano") {
  return {
    version: 1,
    activeProvider: "openai",
    providers: { openai: { apiKey: TEST_PROVIDER_KEY, model } },
  };
}
