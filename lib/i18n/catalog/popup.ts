import { defineMessages, type MessageRef } from "@/lib/i18n/core";
import { commonEn } from "@/lib/i18n/catalog/common.en";
import { commonVi } from "@/lib/i18n/catalog/common.vi";
import { popupEn } from "@/lib/i18n/catalog/popup.en";
import { popupVi } from "@/lib/i18n/catalog/popup.vi";

const popupCatalog = { ...commonEn, ...popupEn };

/** The popup's strings plus the shared ones (`common`). */
export const popupMessages = defineMessages(popupCatalog, {
  ...commonVi,
  ...popupVi,
});
export type PopupMessage = MessageRef<typeof popupCatalog>;
