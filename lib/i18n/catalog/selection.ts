import { defineMessages, type MessageRef } from "@/lib/i18n/core";
import { commonEn } from "@/lib/i18n/catalog/common.en";
import { commonVi } from "@/lib/i18n/catalog/common.vi";
import { selectionEn } from "@/lib/i18n/catalog/selection.en";
import { selectionVi } from "@/lib/i18n/catalog/selection.vi";

const selectionCatalog = { ...commonEn, ...selectionEn };

/** The selection panel's strings plus the shared ones (`common`). */
export const selectionMessages = defineMessages(selectionCatalog, {
  ...commonVi,
  ...selectionVi,
});
export type SelectionMessage = MessageRef<typeof selectionCatalog>;
