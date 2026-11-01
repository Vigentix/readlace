// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The manifest verifier is a directly executable ESM CLI.
import * as manifestVerifier from "./verify-workspace-reader-manifest.mjs";

const { verifyWorkspaceReaderManifest } = manifestVerifier;
const WEB_CLIENT_ID = "987654321098-readlaceweb.apps.googleusercontent.com";

const chromiumBase = {
  manifest_version: 3,
  key: "public-spki-key",
  permissions: ["tabs", "scripting"],
  host_permissions: ["<all_urls>"],
};

function withoutKey(manifest: Record<string, unknown>) {
  const copy = { ...manifest };
  delete copy.key;
  return copy;
}

describe("Workspace Reader manifest verifier", () => {
  it("accepts the exact disabled, portable web, and Firefox contracts", () => {
    expect(verifyWorkspaceReaderManifest(chromiumBase, "disabled")).toBe(true);
    expect(
      verifyWorkspaceReaderManifest(
        {
          ...chromiumBase,
          permissions: ["tabs", "scripting", "sidePanel", "storage"],
          host_permissions: ["<all_urls>"],
          optional_permissions: ["identity"],
          optional_host_permissions: ["https://sheets.googleapis.com/*"],
          side_panel: { default_path: "/reader.html" },
        },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toBe(true);
    expect(
      verifyWorkspaceReaderManifest(
        {
          manifest_version: 2,
          permissions: ["tabs", "scripting", "<all_urls>"],
          browser_specific_settings: {
            gecko: { strict_min_version: "102.0" },
          },
        },
        "firefox",
      ),
    ).toBe(true);
  });

  it("rejects Reader drift in disabled and Firefox manifests", () => {
    for (const [manifest, mode] of [
      [
        {
          ...chromiumBase,
          permissions: ["tabs", "scripting", "identity"],
        },
        "disabled",
      ],
      [{ ...chromiumBase, optional_permissions: ["identity"] }, "disabled"],
      [
        {
          ...chromiumBase,
          optional_host_permissions: ["https://sheets.googleapis.com/*"],
        },
        "disabled",
      ],
      [
        {
          manifest_version: 2,
          permissions: [
            "tabs",
            "scripting",
            "<all_urls>",
            "https://docs.googleapis.com/*",
          ],
          oauth2: {},
          side_panel: { default_path: "/reader.html" },
          browser_specific_settings: {
            gecko: { strict_min_version: "102.0" },
          },
        },
        "firefox",
      ],
    ] as const) {
      expect(() => verifyWorkspaceReaderManifest(manifest, mode)).toThrow();
    }
  });

  it("rejects any enabled permission, host, OAuth, client, or Reader path drift", () => {
    const valid = {
      ...chromiumBase,
      permissions: ["tabs", "scripting", "sidePanel", "storage"],
      host_permissions: ["<all_urls>"],
      optional_permissions: ["identity"],
      optional_host_permissions: ["https://sheets.googleapis.com/*"],
      side_panel: { default_path: "/reader.html" },
    };

    expect(() =>
      verifyWorkspaceReaderManifest(
        { ...valid, permissions: [...valid.permissions, "storage"] },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/permissions/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        {
          ...valid,
          permissions: valid.permissions.filter(
            (permission) => permission !== "storage",
          ),
        },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/permissions/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        {
          ...valid,
          host_permissions: ["<all_urls>", "https://sheets.googleapis.com/*"],
        },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/host_permissions/);
    // ADR 0015: identity and Google API hosts are never required.
    expect(() =>
      verifyWorkspaceReaderManifest(
        {
          ...valid,
          permissions: [...valid.permissions, "identity"],
        },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/permissions/);
    for (const drift of [
      { optional_permissions: [] },
      { optional_permissions: ["identity", "identity.email"] },
      {
        optional_host_permissions: [
          "https://sheets.googleapis.com/*",
          "https://www.googleapis.com/*",
        ],
      },
      { optional_host_permissions: undefined },
    ])
      expect(() =>
        verifyWorkspaceReaderManifest(
          { ...valid, ...drift },
          "enabled-web",
          WEB_CLIENT_ID,
        ),
      ).toThrow(/optional_/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        { ...valid, oauth2: {} },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/oauth2/);
    expect(() =>
      verifyWorkspaceReaderManifest(valid, "enabled-web", "invalid-client"),
    ).toThrow(/client ID/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        { ...valid, side_panel: { default_path: "reader.html" } },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/reader.html/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        { ...valid, oauth2: {} },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/oauth2 must be absent/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        {
          ...valid,
          host_permissions: [
            ...valid.host_permissions,
            "https://drive.googleapis.com/*",
          ],
        },
        "enabled-web",
        WEB_CLIENT_ID,
      ),
    ).toThrow(/host_permissions/);
  });

  it("requires the key for unpacked builds and forbids it for Store builds", () => {
    const storeBase = withoutKey(chromiumBase);
    const storeEnabled = {
      ...storeBase,
      permissions: ["tabs", "scripting", "sidePanel", "storage"],
      optional_permissions: ["identity"],
      optional_host_permissions: ["https://sheets.googleapis.com/*"],
      side_panel: { default_path: "/reader.html" },
    };

    // Unpacked internal builds keep the public key for a stable extension ID.
    expect(() => verifyWorkspaceReaderManifest(storeBase, "disabled")).toThrow(
      /public key must remain present/,
    );
    expect(() =>
      verifyWorkspaceReaderManifest(storeEnabled, "enabled-web", WEB_CLIENT_ID),
    ).toThrow(/public key must remain present/);

    // ADR 0016: the Chrome Web Store assigns the ID; the package has no key.
    expect(
      verifyWorkspaceReaderManifest(storeBase, "disabled", undefined, {
        store: true,
      }),
    ).toBe(true);
    expect(
      verifyWorkspaceReaderManifest(
        storeEnabled,
        "enabled-web",
        WEB_CLIENT_ID,
        {
          store: true,
        },
      ),
    ).toBe(true);
    expect(() =>
      verifyWorkspaceReaderManifest(chromiumBase, "disabled", undefined, {
        store: true,
      }),
    ).toThrow(/Store manifest key must be absent/);
    // The Store variant still enforces every permission contract.
    expect(() =>
      verifyWorkspaceReaderManifest(
        {
          ...storeEnabled,
          permissions: [...storeEnabled.permissions, "identity"],
        },
        "enabled-web",
        WEB_CLIENT_ID,
        { store: true },
      ),
    ).toThrow(/permissions/);
    expect(() =>
      verifyWorkspaceReaderManifest(
        {
          manifest_version: 2,
          permissions: ["tabs", "scripting", "<all_urls>"],
          browser_specific_settings: {
            gecko: { strict_min_version: "102.0" },
          },
        },
        "firefox",
        undefined,
        { store: true },
      ),
    ).toThrow(/Chromium manifests only/);
  });

  it("verifies a Store manifest through the CLI --store flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-manifest-store-"));
    const manifestPath = join(root, "manifest.json");
    const storeBase = withoutKey(chromiumBase);
    const cli = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("./verify-workspace-reader-manifest.mjs", import.meta.url),
          ),
          ...args,
        ],
        { encoding: "utf8" },
      );
    try {
      await writeFile(manifestPath, JSON.stringify(storeBase));
      const unpacked = cli(["--mode", "disabled", manifestPath]);
      expect(unpacked.status).toBe(1);
      expect(unpacked.stderr).toContain("public key must remain present");

      expect(cli(["--mode", "disabled", "--store", manifestPath]).status).toBe(
        0,
      );
      expect(cli(["--store", "--mode", "disabled", manifestPath]).status).toBe(
        0,
      );

      await writeFile(manifestPath, JSON.stringify(chromiumBase));
      const keyed = cli(["--mode", "disabled", "--store", manifestPath]);
      expect(keyed.status).toBe(1);
      expect(keyed.stderr).toContain("Store manifest key must be absent");

      const usage = cli([
        "--mode",
        "disabled",
        "--store",
        "--store",
        manifestPath,
      ]);
      expect(usage.status).toBe(1);
      expect(usage.stderr).toContain("usage:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the CLI with a nonzero exit code on manifest drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-manifest-"));
    const manifestPath = join(root, "manifest.json");
    try {
      await writeFile(manifestPath, JSON.stringify(chromiumBase));
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("./verify-workspace-reader-manifest.mjs", import.meta.url),
          ),
          "--mode",
          "enabled-web",
          manifestPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("permissions");

      await writeFile(
        manifestPath,
        JSON.stringify({
          ...chromiumBase,
          permissions: ["tabs", "scripting", "sidePanel", "storage"],
          host_permissions: ["<all_urls>"],
          optional_permissions: ["identity"],
          optional_host_permissions: ["https://sheets.googleapis.com/*"],
          side_panel: { default_path: "/reader.html" },
        }),
      );
      const webResult = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("./verify-workspace-reader-manifest.mjs", import.meta.url),
          ),
          "--mode",
          "enabled-web",
          manifestPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID,
          },
        },
      );
      expect(webResult.status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
