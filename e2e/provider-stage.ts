import type { BrowserContext, Request, Route } from "@playwright/test";

/**
 * ADR 0020: the extension calls OpenAI directly with the user's own key, one
 * Responses API request per attempt, instead of the backend stage route.
 *
 * The deterministic specs already model a translation stage
 * (`POST /v1/translation-stages`: `{ targetLanguage, sources, sourceRoutes }`
 * in, `{ results, provenance, failures, diagnostics }` out). This adapter
 * turns every OpenAI request into that stage shape, hands it to the spec's
 * existing backend handler, and turns the stage answer back into a Responses
 * API body, so the specs keep one stub for both.
 */
// Built at runtime so the source never contains a key-shaped literal.
export const E2E_PROVIDER_KEY = [
  "sk",
  "e2e",
  "0123456789abcdefghijklmnopqrstuv",
].join("-");
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const STAGE_URL = "https://api.example.test/v1/translation-stages";

const TARGETS: Record<string, string> = {
  English: "en",
  Vietnamese: "vi",
  Japanese: "ja",
};

export interface OpenAIStageRequest {
  targetLanguage: string;
  sources: string[][];
  sourceRoutes: string[][];
  ids: string[];
}

function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, found));
  else if (value && typeof value === "object")
    Object.values(value).forEach((item) => strings(item, found));
  return found;
}

function jsonAfter(prompt: string, label: string) {
  const line = prompt.split("\n").find((entry) => entry.startsWith(label));
  return line ? (JSON.parse(line.slice(label.length)) as unknown) : undefined;
}

/** Reads the record map and routes out of one OpenAI Responses request. */
export function openAIRequestAsStage(body: unknown): OpenAIStageRequest {
  const prompt = strings(body).find((value) => value.includes("Input JSON: "));
  if (!prompt) throw new Error("Not a Readlace translation request.");
  const input = jsonAfter(prompt, "Input JSON: ") as Record<string, string>;
  const routes = (jsonAfter(prompt, "Source routes JSON: ") ?? {}) as Record<
    string,
    string
  >;
  const label = prompt
    .split("\n")
    .find((entry) => entry.startsWith("Target language: "))
    ?.slice("Target language: ".length);
  const ids = Object.keys(input);
  return {
    targetLanguage: TARGETS[label ?? ""] ?? "en",
    sources: [ids.map((id) => input[id]!)],
    sourceRoutes: [ids.map((id) => routes[id] ?? "auto")],
    ids,
  };
}

/** A Responses API body whose structured output maps every id. */
export function openAIResponsesBody(
  translations: Record<string, string>,
  model = "gpt-5-nano",
) {
  return {
    id: "resp_e2e",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_e2e",
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

function stageAnswerAsOpenAI(
  stage: OpenAIStageRequest,
  status: number,
  text: string | undefined,
  model: string,
) {
  if (status < 200 || status >= 300)
    return {
      status,
      body: JSON.stringify({
        error: { message: "Provider failed", type: "server_error" },
      }),
    };
  const answer = JSON.parse(text ?? "{}") as { results?: string[][] };
  // Unresolved records come back empty, which the extension treats as a
  // quality miss, exactly like an empty value from OpenAI.
  const translations = Object.fromEntries(
    stage.ids.map((id, index) => [id, answer.results?.[0]?.[index] ?? ""]),
  );
  return {
    status: 200,
    body: JSON.stringify(openAIResponsesBody(translations, model)),
  };
}

type FulfillOptions = Parameters<Route["fulfill"]>[0];

/**
 * Routes OpenAI Responses requests through a spec's existing stage handler.
 * `handler` is the same function the spec registers for its backend origin.
 */
export async function routeOpenAIThroughStage(
  context: BrowserContext,
  handler: (route: Route) => Promise<unknown> | unknown,
) {
  await context.route(OPENAI_RESPONSES_URL, async (route) => {
    const real = route.request();
    const body = real.postDataJSON() as { model?: string };
    const stage = openAIRequestAsStage(body);
    const stageBody = {
      targetLanguage: stage.targetLanguage,
      sources: stage.sources,
      sourceRoutes: stage.sourceRoutes,
    };
    const request = new Proxy(real, {
      get(target, property) {
        if (property === "url") return () => STAGE_URL;
        if (property === "method") return () => "POST";
        if (property === "postDataJSON") return () => stageBody;
        if (property === "postData") return () => JSON.stringify(stageBody);
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Request;
    const stageRoute = new Proxy(route, {
      get(target, property) {
        if (property === "request") return () => request;
        if (property === "fulfill")
          return async (options: FulfillOptions = {}) => {
            const status = options.status ?? 200;
            const text =
              options.body === undefined
                ? options.json === undefined
                  ? undefined
                  : JSON.stringify(options.json)
                : String(options.body);
            const answer = stageAnswerAsOpenAI(
              stage,
              status,
              text,
              body.model ?? "gpt-5-nano",
            );
            await target.fulfill({
              status: answer.status,
              contentType: "application/json",
              body: answer.body,
            });
          };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Route;
    await handler(stageRoute);
  });
}

/**
 * Saves a test provider key through the real Settings page (ADR 0020), the
 * only sender the background accepts for provider settings.
 */
export async function saveE2EProviderKey(
  context: BrowserContext,
  extensionId: string,
  { apiKey = E2E_PROVIDER_KEY, model = "gpt-5-nano" } = {},
) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const response = (await page.evaluate(
      ([key, chosen]) =>
        (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage(message: unknown): Promise<unknown> };
            };
          }
        ).chrome.runtime.sendMessage({
          type: "PROVIDER_SETTINGS_SAVE",
          apiKey: key,
          model: chosen,
        }),
      [apiKey, model] as const,
    )) as { ok?: boolean } | undefined;
    if (response?.ok !== true)
      throw new Error("The Settings page could not save the test key.");
  } finally {
    await page.close();
  }
}

/** The loaded extension's ID, from its running service worker. */
export function extensionIdOf(context: BrowserContext) {
  const worker = context
    .serviceWorkers()
    .find((candidate) => candidate.url().startsWith("chrome-extension://"));
  const id = worker?.url().split("/")[2];
  if (!id) throw new Error("The extension service worker is not running.");
  return id;
}

/**
 * Routes OpenAI through `handler` and saves the test key, for specs whose
 * translations used to go to the backend stage.
 */
export async function routeE2EProvider(
  context: BrowserContext,
  handler: (route: Route) => Promise<unknown> | unknown,
  { saveKey = true } = {},
) {
  await routeOpenAIThroughStage(context, handler);
  if (saveKey) await saveE2EProviderKey(context, extensionIdOf(context));
}
