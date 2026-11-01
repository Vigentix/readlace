import { beforeEach, expect, it, vi } from "vitest";
const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./indexeddb-storage", () => ({
  extensionStorage: {
    getMany: async (keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, values.get(key)])),
    setMany: async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries))
        values.set(key, value);
    },
  },
}));
import {
  readReaderPreferences,
  saveReaderPreferences,
  READER_TARGET_LANGUAGE_KEY,
} from "./reader-preferences";
beforeEach(() => values.clear());
it("defaults to Vietnamese, ignores saved provider preferences and rejects invalid targets", async () => {
  values.set("translationProvider", "openai");
  values.set("readerPreferences:v1:provider", "google");
  expect(await readReaderPreferences()).toEqual({ targetLanguage: "vi" });
  values.set(READER_TARGET_LANGUAGE_KEY, "invalid");
  expect(await readReaderPreferences()).toEqual({ targetLanguage: "vi" });
});
it("retains an explicit target and never writes a provider", async () => {
  await saveReaderPreferences({ targetLanguage: "en" });
  expect(await readReaderPreferences()).toEqual({ targetLanguage: "en" });
  await saveReaderPreferences({
    targetLanguage: "ja",
    provider: "openai",
  } as never);
  expect(await readReaderPreferences()).toEqual({ targetLanguage: "ja" });
  expect([...values.keys()]).toEqual([READER_TARGET_LANGUAGE_KEY]);
});
