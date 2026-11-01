import { defineMessages, type MessageRef } from "@/lib/i18n/core";
import { commonEn } from "@/lib/i18n/catalog/common.en";
import { commonVi } from "@/lib/i18n/catalog/common.vi";
import { readerEn } from "@/lib/i18n/catalog/reader.en";
import { readerVi } from "@/lib/i18n/catalog/reader.vi";
import { workspaceEn } from "@/lib/i18n/catalog/workspace.en";
import { workspaceVi } from "@/lib/i18n/catalog/workspace.vi";

const readerCatalog = { ...commonEn, ...readerEn, ...workspaceEn };

/** Every Reader page string plus the shared ones (`common`). */
export const readerMessages = defineMessages(readerCatalog, {
  ...commonVi,
  ...readerVi,
  ...workspaceVi,
});
export type ReaderMessage = MessageRef<typeof readerCatalog>;
