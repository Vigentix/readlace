import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";
import {
  chromiumManifestKey,
  isStoreBuild,
  STORE_OUTPUT_DIR,
} from "./shared/auth-identity";
import { workspaceReaderBuildConfig } from "./shared/google-workspace-config";

// Read once, before WXT loads `.env`, so the output directory and the manifest
// `key` can never disagree (ADR 0016).
const storeBuild = isStoreBuild(process.env);

// See https://wxt.dev/api/config.html
export default defineConfig({
  // Store packages never overwrite the unpacked dev build in `.output/`.
  ...(storeBuild ? { outDir: STORE_OUTPUT_DIR } : {}),
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => {
    const workspaceReader = workspaceReaderBuildConfig(process.env, browser);
    return {
      // Localized from `public/_locales` (English default, Vietnamese).
      name: "__MSG_extName__",
      short_name: "__MSG_extShortName__",
      description: "__MSG_extDescription__",
      default_locale: "en",
      action: {
        default_title: "Readlace",
        default_popup: "popup.html",
      },
      // ADR 0020: there is no Readlace backend or web sign-in. The extension
      // talks only to the provider the user configured in Settings.
      incognito: "not_allowed",
      permissions: ["tabs", "scripting", ...workspaceReader.permissions],
      host_permissions: ["<all_urls>"],
      // Google access is optional and requested at Connect (ADR 0015).
      ...(workspaceReader.enabled
        ? {
            optional_permissions: workspaceReader.optionalPermissions,
            optional_host_permissions: workspaceReader.optionalHostPermissions,
          }
        : {}),
      web_accessible_resources: [
        { resources: ["icon/32.png"], matches: ["<all_urls>"] },
      ],
      ...(browser === "firefox"
        ? {
            browser_specific_settings: {
              gecko: { strict_min_version: "102.0" },
            },
          }
        : storeBuild
          ? {}
          : { key: chromiumManifestKey(process.env, false) }),
    };
  },
  hooks: {
    build: {
      manifestGenerated: (wxt, manifest) => {
        const workspaceReader = workspaceReaderBuildConfig(
          process.env,
          wxt.config.browser,
        );
        if (workspaceReader.enabled) {
          manifest.side_panel = { default_path: "/reader.html" };
        } else {
          manifest.permissions = manifest.permissions?.filter(
            (permission) => permission !== "sidePanel",
          );
          delete manifest.side_panel;
        }
        if (wxt.config.browser === "firefox") delete manifest.sidebar_action;
      },
    },
  },
  imports: {
    eslintrc: {
      enabled: 9,
    },
  },
  zip: {
    excludeSources: [
      "output/**",
      "playwright-report/**",
      "test-results/**",
      "docs/security/evidence/**",
      "assets/brand/**",
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
