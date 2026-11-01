export const TARGET_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "vi", label: "Vietnamese" },
  { code: "ja", label: "Japanese" },
] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]["code"];
/**
 * Backend translation stages in flight per translator instance. The backend
 * routes each stage to its engines; the client never names one.
 */
export const TRANSLATION_CONCURRENCY = 2;
export const CACHE_PREFIX = "translationCache:";
export const DETECTION_CACHE_PREFIX = "translationDetection:";
export const PREF_PREFIX = "alwaysTranslate:";
export interface AlwaysTranslatePreference {
  enabled: boolean;
  targetLanguage: TargetLanguage;
}
export function hostnameFromUrl(url?: string) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}
export function preferenceKey(hostname: string) {
  return `${PREF_PREFIX}${hostname}`;
}
