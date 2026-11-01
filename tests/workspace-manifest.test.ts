// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_WORKSPACE_SCOPES } from "@/shared/google-workspace-config";

type Manifest = Record<string, unknown> & {
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
};

interface WxtConfigShape {
  manifest: (env: {
    browser: string;
    manifestVersion: number;
    mode: string;
    command: string;
  }) => Manifest;
  hooks: {
    build: {
      manifestGenerated: (
        wxt: { config: { browser: string } },
        manifest: Manifest,
      ) => void;
    };
  };
}

const WEB_CLIENT_ID = "123456789012-readlaceweb.apps.googleusercontent.com";
const GOOGLE_API_HOSTS = [
  "https://docs.googleapis.com/*",
  "https://sheets.googleapis.com/*",
  "https://www.googleapis.com/*",
];

/** The manifest WXT emits: the config factory, then the build hook. */
async function generatedManifest(
  env: Record<string, string>,
  browser = "chrome",
) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { default: config } = (await import("@/wxt.config")) as {
    default: WxtConfigShape;
  };
  const manifest = config.manifest({
    browser,
    manifestVersion: browser === "firefox" ? 2 : 3,
    mode: "production",
    command: "build",
  });
  // WXT adds sidePanel for the Reader entrypoint before the hook runs.
  manifest.permissions = [...(manifest.permissions ?? []), "sidePanel"];
  config.hooks.build.manifestGenerated({ config: { browser } }, manifest);
  manifest.permissions = [...new Set(manifest.permissions)];
  return manifest;
}

const baseEnv = {
  READLACE_STORE_BUILD: "",
  WXT_GOOGLE_WORKSPACE_CLIENT_ID: "",
  WXT_WEB_ORIGIN: "",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Workspace launch manifest (ADR 0015)", () => {
  it("requires neither identity nor Google API hosts; both are optional and requested at Connect", async () => {
    const manifest = await generatedManifest({
      ...baseEnv,
      WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID,
    });
    expect(manifest.permissions).toEqual([
      "tabs",
      "scripting",
      "sidePanel",
      "storage",
    ]);
    expect(manifest.permissions).not.toContain("identity");
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    for (const host of GOOGLE_API_HOSTS)
      expect(manifest.host_permissions).not.toContain(host);
    expect(manifest.optional_permissions).toEqual(["identity"]);
    expect(manifest.optional_host_permissions).toEqual([
      "https://sheets.googleapis.com/*",
    ]);
    expect(manifest.side_panel).toEqual({ default_path: "/reader.html" });
    expect(manifest).not.toHaveProperty("oauth2");
    expect(GOOGLE_WORKSPACE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ]);
  });

  it("ships a Store build without the Workspace client ID and with no Google permission at all", async () => {
    const manifest = await generatedManifest({
      ...baseEnv,
      READLACE_STORE_BUILD: "1",
      WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: "",
    });
    expect(manifest.permissions).toEqual(["tabs", "scripting"]);
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("side_panel");
    expect(manifest).not.toHaveProperty("key");
  });

  it("keeps Firefox free of Workspace permissions even with a client ID", async () => {
    const manifest = await generatedManifest(
      { ...baseEnv, WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID },
      "firefox",
    );
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest.permissions).not.toContain("identity");
  });
});
