import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createOpenAIHtmlTranslator,
  type OpenAIRecordSourceMap,
  type OpenAITranslationMap,
} from "./openai-html";

const captured = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures/openai-untranslated-batch.html",
  ),
  "utf8",
).trim();

function unescapeHtml(text: string) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function nodesFromPiece(html: string): string[] {
  let inner = html.trim();
  if (inner.includes("<pre")) {
    inner = inner.replace(/<\/pre>\s*$/i, "");
    inner = inner.slice(inner.indexOf(">") + 1);
  }
  const matches = [
    ...inner.matchAll(/<a\s+i=([0-9]+)>((?:(?!<\/a>).)*)<\/a>/gi),
  ];
  if (!matches.length) return [unescapeHtml(inner)];
  const sorted: string[] = [];
  for (const match of matches) {
    sorted[Number.parseInt(match[1] ?? "", 10)] = unescapeHtml(match[2] ?? "");
  }
  return sorted.map((text) => text ?? "");
}

function sourcesFromCaptured(html: string): string[][] {
  const found = [...html.matchAll(/<batch\s+i=([0-9]+)>([\s\S]*?)<\/batch>/gi)];
  found.sort(
    (left, right) =>
      Number.parseInt(left[1] ?? "", 10) - Number.parseInt(right[1] ?? "", 10),
  );
  return found.map((match) => nodesFromPiece(match[2] ?? ""));
}

describe("captured gpt-5-nano batch response", () => {
  it("encodes the 79-piece sample compactly and maps every indexed result", async () => {
    const sources = sourcesFromCaptured(captured);
    const prompts: OpenAITranslationMap[] = [];
    const routes: OpenAIRecordSourceMap[] = [];
    const html = createOpenAIHtmlTranslator({
      completeHtml: async (prompt, sourceLanguages) => {
        prompts.push(prompt);
        routes.push(sourceLanguages);
        return Object.fromEntries(
          Object.entries(prompt).map(([id, text]) => [id, `vi:${text}`]),
        );
      },
      storage: {
        async get() {
          return undefined;
        },
        async set() {
          return undefined;
        },
        async getMany() {
          return {};
        },
        async setMany() {
          return undefined;
        },
        async getAll() {
          return {};
        },
        async remove() {
          return undefined;
        },
      },
      getApiKey: async () => "sk-test",
    });
    const result = await html.translateHtml(sources, "vi");
    const appliedMismatches = result.results.flatMap((nodes, index) => {
      const source = sources[index] ?? [];
      if (
        nodes.length === source.length &&
        nodes.every(
          (text, nodeIndex) =>
            text === source[nodeIndex] || text === `vi:${source[nodeIndex]}`,
        )
      )
        return [];
      return [{ index, source, nodes }];
    });
    const snapshot = {
      sourcePieces: sources.length,
      openaiCalls: prompts.length,
      promptChars: prompts.reduce(
        (total, prompt) => total + JSON.stringify(prompt).length,
        0,
      ),
      legacyArrayChars: prompts.reduce(
        (total, prompt) =>
          total +
          JSON.stringify(
            Object.entries(prompt).map(([id, text]) => ({ id, text })),
          ).length,
        0,
      ),
      capturedHtmlChars: captured.length,
      failures: result.failures,
      appliedMismatches: appliedMismatches.length,
      firstResult: result.results[0],
      firstSource: sources[0],
    };
    expect(snapshot, JSON.stringify({ appliedMismatches })).toMatchObject({
      sourcePieces: 79,
      failures: [],
      appliedMismatches: 0,
      firstResult: ["vi:Skip to Main"],
    });
    expect(snapshot.openaiCalls).toBe(1);
    expect(Object.keys(routes[0] ?? {})).toEqual(Object.keys(prompts[0] ?? {}));
    expect(
      prompts.every(
        (prompt) =>
          Object.keys(prompt).length <= 128 &&
          Object.values(prompt).reduce(
            (sum, source) => sum + source.length,
            0,
          ) <= 8_000,
      ),
    ).toBe(true);
    expect(snapshot.promptChars).toBeLessThan(snapshot.capturedHtmlChars);
    expect(snapshot.promptChars).toBeLessThan(snapshot.legacyArrayChars * 0.75);
  });
});
