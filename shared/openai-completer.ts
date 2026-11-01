import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, Output } from "ai";
import type {
  ApiSourceLanguage,
  ApiTargetLanguage,
} from "./translation-api.js";

export const OPENAI_MODEL = "gpt-5-nano";
export type OpenAITranslationMap = Record<string, string>;
export type OpenAIRecordSourceMap = Record<string, ApiSourceLanguage>;

export interface OpenAIRequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export const OPENAI_STRICT_INSTRUCTIONS =
  "Translate every map value completely to the target language, including short UI labels and news headlines. Return exactly one translated string for every input key. When a source route differs from the target, its output must not equal the input or leave target-incompatible source-script sentences untranslated. Preserve Latin names and numbers; transliterate non-target-script proper names when needed. The source route map gives each input record's source language; auto means infer it. Never return source-route labels such as auto, ja, en, or vi as translations.";

function translationSchema(ids: string[]) {
  return jsonSchema<OpenAITranslationMap>({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      ids.map((id) => [id, { type: "string", minLength: 1 }]),
    ),
    required: ids,
  });
}

function translationExample(targetLanguage: ApiTargetLanguage) {
  return targetLanguage === "ja"
    ? 'Example JSON: {"r0":"Invoice management"} -> {"r0":"請求管理"}'
    : targetLanguage === "vi"
      ? 'Example JSON: {"r0":"請求管理"} -> {"r0":"Quản lý hóa đơn"}'
      : 'Example JSON: {"r0":"請求管理"} -> {"r0":"Invoice management"}';
}

const languageLabel: Record<ApiTargetLanguage, string> = {
  en: "English",
  vi: "Vietnamese",
  ja: "Japanese",
};

export function createOpenAiCompleter(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  model: string = OPENAI_MODEL,
) {
  return async (
    sources: OpenAITranslationMap,
    sourceLanguages: OpenAIRecordSourceMap,
    targetLanguage: ApiTargetLanguage,
    onUsage?: (usage: OpenAIRequestUsage) => void,
    signal?: AbortSignal,
  ) => {
    const openai = createOpenAI({ apiKey, fetch: fetchImpl });
    const { output, usage } = await generateText({
      model: openai(model),
      maxRetries: 0,
      ...(signal ? { abortSignal: signal } : {}),
      output: Output.object({
        schema: translationSchema(Object.keys(sources)),
        name: "translations",
      }),
      instructions: OPENAI_STRICT_INSTRUCTIONS,
      prompt: [
        `Target language: ${languageLabel[targetLanguage]}`,
        translationExample(targetLanguage),
        `Source routes JSON: ${JSON.stringify(sourceLanguages)}`,
        `Input JSON: ${JSON.stringify(sources)}`,
      ].join("\n"),
      providerOptions: {
        openai: {
          reasoningEffort: "minimal",
          instructions: OPENAI_STRICT_INSTRUCTIONS,
          serviceTier: "default",
        },
      },
    });
    onUsage?.({
      ...(usage.inputTokens === undefined
        ? {}
        : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined
        ? {}
        : { outputTokens: usage.outputTokens }),
      ...(usage.outputTokenDetails.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
      ...(usage.inputTokenDetails.cacheReadTokens === undefined
        ? {}
        : { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }),
    });
    return output;
  };
}
