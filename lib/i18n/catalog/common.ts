import { defineMessages } from "@/lib/i18n/core";
import { commonEn } from "@/lib/i18n/catalog/common.en";
import { commonVi } from "@/lib/i18n/catalog/common.vi";
import type { TargetLanguage } from "@/lib/translation";

export const commonMessages = defineMessages(commonEn, commonVi);

/** `language.<code>` for a target language code. */
export function languageKey(code: TargetLanguage) {
  return `language.${code}` as const;
}
