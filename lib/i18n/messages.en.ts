import { commonEn } from "@/lib/i18n/catalog/common.en";
import { popupEn } from "@/lib/i18n/catalog/popup.en";
import { readerEn } from "@/lib/i18n/catalog/reader.en";
import { selectionEn } from "@/lib/i18n/catalog/selection.en";
import { settingsEn } from "@/lib/i18n/catalog/settings.en";
import { workspaceEn } from "@/lib/i18n/catalog/workspace.en";

/**
 * English UI messages: the source of truth for every message key. Each
 * namespace lives in `catalog/<namespace>.en.ts` so a surface bundles only
 * what it shows (`catalog/popup.ts`, `catalog/reader.ts`,
 * `catalog/selection.ts`); keys are unique across namespaces.
 */
export const en = {
  common: commonEn,
  popup: popupEn,
  selection: selectionEn,
  settings: settingsEn,
  reader: readerEn,
  workspace: workspaceEn,
} as const;

export type Messages = typeof en;
export type Namespace = keyof Messages;
