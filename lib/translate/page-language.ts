import type { TargetLanguage } from "@/lib/translation";

export type RecordSourceLanguage = TargetLanguage | "auto";

export type PageTranslationState =
  "original" | "translating" | "preparing" | "translated" | "partial" | "error";

export function settlePageTranslationState({
  accepted,
  unresolved,
}: {
  accepted: boolean;
  unresolved: boolean;
}): Extract<PageTranslationState, "translated" | "partial" | "error"> {
  return accepted ? (unresolved ? "partial" : "translated") : "error";
}

/** Maps an inconclusive detector code to Unknown; otherwise returns the raw code. */
export function displayPageLanguage(code?: string) {
  if (!code || code === "und" || code.toLowerCase() === "unknown")
    return "Unknown";
  return code;
}

/** Lowercase BCP-47 primary subtag (`en-US` / `en_US` → `en`). */
function primarySubtag(code?: string) {
  if (!code) return undefined;
  const normalized = code.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(normalized)) return undefined;
  return normalized.split("-")[0];
}

/** Maps a language tag to a skip target, or null when it is not en|vi|ja. */
function toTargetLanguage(code?: string): TargetLanguage | null {
  const primary = primarySubtag(code);
  if (primary === "en" || primary === "vi" || primary === "ja") return primary;
  return null;
}

/**
 * Returns a source language only when independent tab and root evidence agree.
 * This informs provider source context only; it is deliberately separate from
 * automatic translation gating.
 */
export function resolveTrustedSourceLanguage({
  detected,
  htmlLang,
}: {
  detected?: string;
  htmlLang?: string;
}): TargetLanguage | null {
  const detectedTarget = toTargetLanguage(detected);
  const htmlTarget = toTargetLanguage(htmlLang);
  return detectedTarget && detectedTarget === htmlTarget
    ? detectedTarget
    : null;
}

/** True when a record has letters compatible with a trusted page source. */
export function hasTrustedSourceScript(
  source: string,
  sourceLanguage: TargetLanguage,
) {
  const letters = source.match(/\p{Letter}/gu);
  if (!letters?.length) return false;
  const compatible =
    sourceLanguage === "ja"
      ? /^(?:\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana})$/u
      : /^\p{Script_Extensions=Latin}$/u;
  return letters.every((letter) => compatible.test(letter));
}

/** Native ja recovery permits common Japanese labels with Latin suffixes. */
export function hasNativeJapaneseSourceScript(source: string) {
  const letters = source.match(/\p{Letter}/gu);
  if (!letters?.length) return false;
  const japanese =
    /^(?:\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana})$/u;
  const latin = /^\p{Script_Extensions=Latin}$/u;
  return (
    letters.some((letter) => japanese.test(letter)) &&
    letters.every((letter) => japanese.test(letter) || latin.test(letter))
  );
}

/** Routes one record using Japanese script first, then a compatible page hint. */
export function resolveRecordSourceLanguage(
  source: string,
  pageHint?: TargetLanguage,
): RecordSourceLanguage {
  if (hasNativeJapaneseSourceScript(source)) return "ja";
  return pageHint && hasTrustedSourceScript(source, pageHint)
    ? pageHint
    : "auto";
}

/** Resolves popup label and automatic-only skip from detector + html lang. */
export function resolvePageLanguage({
  detected,
  htmlLang,
}: {
  detected?: string;
  htmlLang?: string;
}): { label: string; autoSkipTarget: TargetLanguage | null } {
  const trusted = resolveTrustedSourceLanguage({ detected, htmlLang });
  if (trusted) {
    return { label: trusted, autoSkipTarget: trusted };
  }
  const detectedTarget = toTargetLanguage(detected);
  const htmlTarget = toTargetLanguage(htmlLang);
  if (detectedTarget && htmlTarget) {
    return { label: "Unknown", autoSkipTarget: null };
  }
  return { label: displayPageLanguage(detected), autoSkipTarget: null };
}

/** Reads root `lang`; standalone `xml:lang` is not an HTML language vote. */
export function readHtmlLang(doc: Document): string {
  return doc.documentElement.lang?.trim() ?? "";
}

/** True when always-translate should start a run for this preference and skip result. */
export function shouldStartAlwaysTranslate({
  enabled,
  targetLanguage,
  autoSkipTarget,
  openAiBlocked,
}: {
  enabled: boolean;
  targetLanguage: TargetLanguage;
  autoSkipTarget: TargetLanguage | null;
  openAiBlocked: boolean;
}) {
  if (!enabled || openAiBlocked || autoSkipTarget === targetLanguage)
    return false;
  return true;
}

/** True when explicit Translate can start a new run for this target and tab state. */
export function shouldEnableTranslate({
  state,
  targetLanguage,
  appliedTarget,
  busy,
  openAiBlocked,
}: {
  state: PageTranslationState;
  targetLanguage: TargetLanguage;
  appliedTarget?: TargetLanguage;
  busy: boolean;
  openAiBlocked: boolean;
}): boolean {
  if (busy || openAiBlocked) return false;
  if (state === "translating" || state === "preparing") return false;
  if (state === "translated" && appliedTarget === targetLanguage) return false;
  return true;
}
