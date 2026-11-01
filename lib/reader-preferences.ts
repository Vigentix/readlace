import { extensionStorage } from "./indexeddb-storage";
import { TARGET_LANGUAGES, type TargetLanguage } from "./translation";

export const READER_TARGET_LANGUAGE_KEY = "readerPreferences:v1:targetLanguage";

/**
 * Reader preferences hold only the target language. Provider values saved by
 * earlier builds (`readerPreferences:v1:provider`, `translationProvider`) are
 * ignored: the backend routes engines (ADR 0014).
 */
export interface ReaderPreferences {
  targetLanguage: TargetLanguage;
}

export async function readReaderPreferences(): Promise<ReaderPreferences> {
  const values = await extensionStorage.getMany([READER_TARGET_LANGUAGE_KEY]);
  const target = values[READER_TARGET_LANGUAGE_KEY];
  return {
    targetLanguage: TARGET_LANGUAGES.some(
      (language) => language.code === target,
    )
      ? (target as TargetLanguage)
      : "vi",
  };
}

export async function saveReaderPreferences(patch: Partial<ReaderPreferences>) {
  const entries: Record<string, unknown> = {};
  if (
    TARGET_LANGUAGES.some((language) => language.code === patch.targetLanguage)
  )
    entries[READER_TARGET_LANGUAGE_KEY] = patch.targetLanguage;
  if (Object.keys(entries).length) await extensionStorage.setMany(entries);
}
