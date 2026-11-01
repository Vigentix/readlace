import type { TargetLanguage } from "@/lib/translation";
import { hasTrustedSourceScript } from "@/lib/translate/page-language";

const APPENDED_PUNCTUATION = /^[\s:：;；,，.。!！?？…‥·・、|｜-]+$/;

export type ProviderTranslationAssessment =
  | { status: "accepted"; text: string }
  | { status: "quality-miss"; reason: "source-identical" };

export function isDeterministicTranslationValue(text: string): boolean {
  const value = text.trim();
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
    /^(?:https?:\/\/|www\.)\S+$/i.test(value) ||
    /^(?=.*\p{N})[\p{Sc}\p{N}\p{P}\s+−]+$/u.test(value) ||
    /^(?=.*[\p{P}\p{S}])[\p{P}\p{S}\s]+$/u.test(value) ||
    /^[A-Z][A-Z\d]{0,9}[-_][A-Z\d._-]*\d[A-Z\d._-]*$/.test(value) ||
    /^(?:<\/?[A-Za-z][^<>]*>|[A-Za-z_$][\w$]*\s*=>\s*\S.*)$/.test(value) ||
    /^(?:[A-Za-z_$][\w$.-]*|\d+(?:\.\d+)?)\s*(?:===|!==|&&|\|\||\?\?)\s*(?:[A-Za-z_$][\w$.-]*|\d+(?:\.\d+)?|["'`][^"'`]*["'`])$/.test(
      value,
    ) ||
    /^[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)+$/.test(value)
  );
}

/**
 * A provider sometimes appends connective punctuation to a fragment it could
 * not translate — e.g. a brand name inside a merged multi-node piece comes
 * back as "OFFICE SHEETS MAN:". Keep the exact source when the "translation"
 * is the source plus trailing punctuation only.
 */
export function preserveUntranslatedSource(
  source: string,
  translated: string,
): string {
  const trimmedSource = source.trim();
  const trimmedTranslated = translated.trim();
  if (!trimmedSource || trimmedTranslated.length <= trimmedSource.length) {
    return translated;
  }
  if (!trimmedTranslated.startsWith(trimmedSource)) return translated;
  const appended = trimmedTranslated.slice(trimmedSource.length);
  return APPENDED_PUNCTUATION.test(appended) ? source : translated;
}

/**
 * Unchanged provider text is trustworthy only for deterministic local values
 * or trusted script evidence that the record is already in the target.
 */
export function assessProviderTranslation(
  source: string,
  candidate: string,
  targetLanguage: TargetLanguage,
  sourceLanguage?: TargetLanguage,
): ProviderTranslationAssessment {
  const text = preserveUntranslatedSource(source, candidate);
  if (
    text.trim() === source.trim() &&
    !isDeterministicTranslationValue(source) &&
    (sourceLanguage === undefined ||
      (sourceLanguage !== targetLanguage &&
        (hasTrustedSourceScript(source, sourceLanguage) ||
          !hasTrustedSourceScript(source, targetLanguage))))
  ) {
    return { status: "quality-miss", reason: "source-identical" };
  }
  return { status: "accepted", text };
}
