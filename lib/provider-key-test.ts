export const OPENAI_API_ORIGIN = "https://api.openai.com";
export const KEY_TEST_TIMEOUT_MS = 15_000;

export const KEY_TEST_RESULTS = [
  "valid",
  "invalid-key",
  "model-unavailable",
  "rate-limited",
  "unreachable",
] as const;
export type KeyTestResult = (typeof KEY_TEST_RESULTS)[number];

/**
 * Checks a key without spending tokens: retrieving the chosen model needs a
 * valid key and access to that model. Only the status is read; the body and
 * any error text are ignored so nothing provider-written reaches the UI.
 */
export async function testOpenAIKey(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<KeyTestResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${OPENAI_API_ORIGIN}/v1/models/${encodeURIComponent(model)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
      },
    );
  } catch {
    return "unreachable";
  }
  void response.body?.cancel().catch(() => undefined);
  if (response.ok) return "valid";
  if (response.status === 401 || response.status === 403) return "invalid-key";
  if (response.status === 404) return "model-unavailable";
  if (response.status === 429) return "rate-limited";
  return "unreachable";
}
