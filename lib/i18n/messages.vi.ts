import type { Translation } from "@/lib/i18n/core";
import type { Messages } from "@/lib/i18n/messages.en";
import { commonVi } from "@/lib/i18n/catalog/common.vi";
import { popupVi } from "@/lib/i18n/catalog/popup.vi";
import { readerVi } from "@/lib/i18n/catalog/reader.vi";
import { selectionVi } from "@/lib/i18n/catalog/selection.vi";
import { settingsVi } from "@/lib/i18n/catalog/settings.vi";
import { workspaceVi } from "@/lib/i18n/catalog/workspace.vi";

/**
 * Vietnamese UI messages. Every namespace must be a `Translation` of its
 * English catalog, so a missing or extra key fails `pnpm compile`.
 */
export const vi: { readonly [N in keyof Messages]: Translation<Messages[N]> } =
  {
    common: commonVi,
    popup: popupVi,
    selection: selectionVi,
    settings: settingsVi,
    reader: readerVi,
    workspace: workspaceVi,
  };
