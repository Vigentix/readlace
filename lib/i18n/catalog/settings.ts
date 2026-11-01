import { defineMessages, type MessageRef } from "@/lib/i18n/core";
import { commonEn } from "@/lib/i18n/catalog/common.en";
import { commonVi } from "@/lib/i18n/catalog/common.vi";
import { settingsEn } from "@/lib/i18n/catalog/settings.en";
import { settingsVi } from "@/lib/i18n/catalog/settings.vi";

const settingsCatalog = { ...commonEn, ...settingsEn };

/** The Settings page's strings plus the shared ones (`common`). */
export const settingsMessages = defineMessages(settingsCatalog, {
  ...commonVi,
  ...settingsVi,
});
export type SettingsMessage = MessageRef<typeof settingsCatalog>;
