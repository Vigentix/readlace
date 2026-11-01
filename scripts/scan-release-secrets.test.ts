// @vitest-environment node
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The production scanner is a directly executable ESM CLI.
import * as releaseSecretScanner from "./scan-release-secrets.mjs";

const {
  scanTargets,
  scanText,
  validateAuthManifest,
  validateChromeBackendBundle,
  validateRequiredTargets,
  validateStoreManifest,
} = releaseSecretScanner;

describe("release secret scanner", () => {
  it("reports classifications and counts without returning raw matches", () => {
    const findings = scanText(
      [
        "AIza" + "a".repeat(35),
        "sk-proj-" + "b".repeat(40),
        "-----BEGIN PRIVATE KEY-----",
        'client_secret="fixture-' + "c".repeat(24) + '"',
        'ACCOUNT_PROVISIONING_TOKEN="' + "d".repeat(44) + '"',
        "postgresql://fixture-user:fixture-password@db.invalid/vault",
        'refreshToken="fixture-' + "e".repeat(24) + '"',
      ].join("\n"),
    );
    expect(findings).toEqual([
      { id: "openai-key", count: 1 },
      { id: "google-key", count: 1 },
      { id: "private-key", count: 1 },
      { id: "oauth-client-secret", count: 1 },
      { id: "account-provisioning-token", count: 1 },
      { id: "database-credential", count: 1 },
      { id: "refresh-token", count: 1 },
    ]);
    expect(JSON.stringify(findings)).not.toContain("AIza");
    expect(JSON.stringify(findings)).not.toContain("sk-proj");
  });

  it("rejects a non-localhost HTTP backend in generated JavaScript", () => {
    expect(
      scanText('new AuthSession({baseUrl:"http://backend.example.test"})'),
    ).toContainEqual({ id: "insecure-backend-url", count: 1 });
    expect(
      scanText('new AuthSession({baseUrl:"http://localhost:8787"})'),
    ).not.toContainEqual(
      expect.objectContaining({ id: "insecure-backend-url" }),
    );
  });

  it("fails when required release targets are absent or unspecified", async () => {
    await expect(validateRequiredTargets([])).resolves.toEqual([
      { path: ".", id: "no-release-targets", count: 1 },
    ]);
    await expect(
      validateRequiredTargets([".output/not-built.zip"]),
    ).resolves.toEqual([
      {
        path: ".output/not-built.zip",
        id: "missing-release-target",
        count: 1,
      },
    ]);
  });

  it("rejects the local packaging PEM if it enters a release target", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-secret-scan-"));
    const output = join(root, ".output");
    const releaseTarget = join(output, "chrome-mv3");
    const localPem = join(output, "chrome-mv3.pem");
    try {
      await mkdir(releaseTarget, { recursive: true });
      await writeFile(
        join(releaseTarget, "manifest.json"),
        JSON.stringify({ manifest_version: 3, permissions: ["tabs"] }),
      );
      await writeFile(localPem, "-----BEGIN PRIVATE KEY-----\nfixture\n");
      await expect(scanTargets([".output/chrome-mv3"], root)).resolves.toEqual(
        [],
      );

      await copyFile(localPem, join(releaseTarget, "chrome-mv3.pem"));
      await expect(scanTargets([".output/chrome-mv3"], root)).resolves.toEqual([
        {
          path: join(".output", "chrome-mv3", "chrome-mv3.pem"),
          id: "private-key",
          count: 1,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale OAuth and credential JavaScript in backend artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-stale-backend-"));
    const auth = join(root, "backend", "dist", "backend", "src", "auth");
    const credentials = join(
      root,
      "backend",
      "dist",
      "backend",
      "src",
      "credentials",
    );
    try {
      await mkdir(auth, { recursive: true });
      await mkdir(credentials, { recursive: true });
      await writeFile(join(auth, "google-web-oauth.js"), "export {};\n");
      await writeFile(
        join(credentials, "credential-service.js"),
        "export {};\n",
      );
      await expect(scanTargets(["backend/dist"], root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "obsolete-oauth-artifact" }),
          expect.objectContaining({ id: "obsolete-credential-artifact" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only the exact portable Chrome Workspace Reader auth contract", () => {
    expect(validateAuthManifest("not-json", "chrome")).toEqual([
      { id: "invalid-chrome-manifest-json", count: 1 },
    ]);
    expect(validateAuthManifest("null", "chrome")).toEqual([
      { id: "invalid-chrome-manifest-json", count: 1 },
    ]);
    expect(
      validateAuthManifest(
        JSON.stringify({ oauth2: {}, permissions: ["tabs", "identity"] }),
        "chrome",
      ),
    ).toEqual([
      { id: "chrome-oauth2-leakage", count: 1 },
      { id: "chrome-identity-permission-leakage", count: 1 },
    ]);
    const webReaderManifest = {
      manifest_version: 3,
      permissions: ["tabs", "scripting", "sidePanel", "storage"],
      host_permissions: ["<all_urls>"],
      optional_permissions: ["identity"],
      optional_host_permissions: ["https://sheets.googleapis.com/*"],
      side_panel: { default_path: "/reader.html" },
    };
    expect(
      validateAuthManifest(JSON.stringify(webReaderManifest), "chrome"),
    ).toEqual([]);
    for (const mutation of [
      {
        oauth2: {
          scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        },
      },
      // ADR 0015: required identity or Google API hosts are leakage.
      { permissions: [...webReaderManifest.permissions, "identity"] },
      {
        host_permissions: [
          ...webReaderManifest.host_permissions,
          "https://sheets.googleapis.com/*",
        ],
      },
      {
        optional_host_permissions: [
          "https://sheets.googleapis.com/*",
          "https://www.googleapis.com/*",
        ],
      },
      { optional_host_permissions: [] },
      { optional_permissions: ["identity", "identity.email"] },
      { side_panel: { default_path: "/popup.html" } },
      {
        permissions: webReaderManifest.permissions.filter(
          (permission) => permission !== "sidePanel",
        ),
      },
      {
        permissions: webReaderManifest.permissions.filter(
          (permission) => permission !== "storage",
        ),
      },
      { permissions: [...webReaderManifest.permissions, "webRequest"] },
      { oauth2: { audience: "unexpected" } },
      {
        oauth2: {
          client_id: "client-reader.apps.googleusercontent.com",
        },
      },
      {
        oauth2: {
          client_id: "123456-Reader.apps.googleusercontent.com",
        },
      },
    ]) {
      expect(
        validateAuthManifest(
          JSON.stringify({ ...webReaderManifest, ...mutation }),
          "chrome",
        ),
      ).toEqual(
        expect.arrayContaining([
          { id: "chrome-identity-permission-leakage", count: 1 },
        ]),
      );
    }
    expect(
      validateAuthManifest(
        JSON.stringify({ oauth2: {}, permissions: ["identity"] }),
        "firefox",
      ),
    ).toEqual([
      { id: "firefox-oauth2-leakage", count: 1 },
      { id: "firefox-identity-permission-leakage", count: 1 },
    ]);
    expect(
      validateAuthManifest(
        JSON.stringify({ optional_permissions: ["identity"] }),
        "firefox",
      ),
    ).toEqual([{ id: "firefox-identity-permission-leakage", count: 1 }]);
    expect(
      validateAuthManifest(
        JSON.stringify({ optional_permissions: ["identity"] }),
        "chrome",
      ),
    ).toEqual([{ id: "chrome-identity-permission-leakage", count: 1 }]);
    expect(validateAuthManifest("{}", "chrome")).toEqual([]);
    expect(validateAuthManifest("{}", "firefox")).toEqual([]);
  });

  it("rejects obsolete Google login markers without rejecting resource auth", () => {
    const findings = scanText(
      [
        ["/v1/auth/google", "/token"].join(""),
        ["launchWeb", "AuthFlow"].join(""),
        ["getAuth", "Token"].join(""),
      ].join("\n"),
    );
    expect(findings).toEqual([
      { id: "native-google-auth-route", count: 1 },
      { id: "embedded-google-auth-flow", count: 1 },
    ]);
    expect(JSON.stringify(findings)).not.toContain("/v1/auth");
    expect(JSON.stringify(findings)).not.toContain("launchWebAuthFlow");
    expect(
      scanText(
        [["/v1/auth/google", "/token"].join(""), "launchWebAuthFlow"].join(
          "\n",
        ),
        { allowWorkspaceWebAuth: true },
      ),
    ).toEqual([{ id: "native-google-auth-route", count: 1 }]);
    expect(
      scanText("launchWebAuthFlow sk-proj-" + "b".repeat(40), {
        allowWorkspaceWebAuth: true,
      }),
    ).toEqual([{ id: "openai-key", count: 1 }]);
  });

  it("accepts valid Chrome and Firefox package contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-auth-scan-"));
    const chrome = join(root, ".output", "chrome-mv3");
    const firefox = join(root, ".output", "firefox-mv2");
    try {
      await mkdir(chrome, { recursive: true });
      await mkdir(firefox, { recursive: true });
      await writeFile(
        join(chrome, "manifest.json"),
        JSON.stringify({ manifest_version: 3, permissions: ["tabs"] }),
      );
      await writeFile(
        join(firefox, "manifest.json"),
        JSON.stringify({ manifest_version: 2 }),
      );
      await expect(
        scanTargets(
          [join(".output", "chrome-mv3"), join(".output", "firefox-mv2")],
          root,
        ),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows launchWebAuthFlow only in an exact web Reader package", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-web-auth-scan-"));
    const chrome = join(root, ".output", "chrome-mv3");
    const firefox = join(root, ".output", "firefox-mv2");
    const manifest = {
      manifest_version: 3,
      permissions: ["tabs", "scripting", "sidePanel", "storage"],
      host_permissions: ["<all_urls>"],
      optional_permissions: ["identity"],
      optional_host_permissions: ["https://sheets.googleapis.com/*"],
      side_panel: { default_path: "/reader.html" },
    };
    try {
      await mkdir(chrome, { recursive: true });
      await writeFile(join(chrome, "manifest.json"), JSON.stringify(manifest));
      await writeFile(
        join(chrome, "background.js"),
        "browser.identity.launchWebAuthFlow({interactive:true});",
      );
      await expect(
        scanTargets([join(".output", "chrome-mv3")], root),
      ).resolves.toEqual([]);

      await mkdir(firefox, { recursive: true });
      await writeFile(
        join(firefox, "manifest.json"),
        JSON.stringify({ manifest_version: 2 }),
      );
      await writeFile(
        join(firefox, "background.js"),
        "browser.identity.launchWebAuthFlow({interactive:true});",
      );
      await expect(
        scanTargets([join(".output", "firefox-mv2")], root),
      ).resolves.toEqual([
        expect.objectContaining({ id: "embedded-google-auth-flow" }),
      ]);
      await writeFile(join(firefox, "background.js"), "const disabled=true;");
      await expect(
        scanTargets([join(".output", "firefox-mv2")], root),
      ).resolves.toEqual([]);

      for (const permissions of [
        manifest.permissions.filter((permission) => permission !== "storage"),
        [...manifest.permissions, "webRequest"],
      ]) {
        await writeFile(
          join(chrome, "manifest.json"),
          JSON.stringify({ ...manifest, permissions }),
        );
        await expect(
          scanTargets([join(".output", "chrome-mv3")], root),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "embedded-google-auth-flow" }),
            expect.objectContaining({
              id: "chrome-identity-permission-leakage",
            }),
          ]),
        );
      }

      for (const drift of [
        { host_permissions: [...manifest.host_permissions, "https://*/*"] },
        {
          optional_host_permissions: [
            ...manifest.optional_host_permissions,
            "https://www.googleapis.com/*",
          ],
        },
        { permissions: [...manifest.permissions, "identity"] },
      ]) {
        await writeFile(
          join(chrome, "manifest.json"),
          JSON.stringify({ ...manifest, ...drift }),
        );
        await expect(
          scanTargets([join(".output", "chrome-mv3")], root),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "embedded-google-auth-flow" }),
            expect.objectContaining({
              id: "chrome-identity-permission-leakage",
            }),
          ]),
        );
      }

      const backend = join(root, "backend", "dist");
      await mkdir(backend, { recursive: true });
      await writeFile(
        join(backend, "auth.js"),
        "browser.identity.launchWebAuthFlow({interactive:true});",
      );
      await expect(
        scanTargets([join("backend", "dist")], root, {
          allowWorkspaceWebAuth: true,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: "embedded-google-auth-flow" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts inert Reader auth code in a Chrome package that cannot grant identity (ADR 0015)", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-inert-auth-scan-"));
    const chrome = join(root, ".output", "store", "chrome-mv3");
    const target = join(".output", "store", "chrome-mv3");
    const storeManifest = {
      manifest_version: 3,
      permissions: ["tabs", "scripting"],
      host_permissions: ["<all_urls>"],
    };
    try {
      await mkdir(chrome, { recursive: true });
      await writeFile(
        join(chrome, "manifest.json"),
        JSON.stringify(storeManifest),
      );
      await writeFile(
        join(chrome, "background.js"),
        "browser.identity?.launchWebAuthFlow;",
      );
      await expect(
        scanTargets([target], root, { store: true }),
      ).resolves.toEqual([]);

      // Real secrets are still reported in the same package.
      await writeFile(
        join(chrome, "background.js"),
        `browser.identity?.launchWebAuthFlow;const k="sk-proj-${"c".repeat(40)}";`,
      );
      await expect(scanTargets([target], root)).resolves.toEqual([
        expect.objectContaining({ id: "openai-key" }),
      ]);

      // Any identity grant outside the exact Reader shape keeps the rule.
      for (const grant of [
        { permissions: ["tabs", "scripting", "identity"] },
        { optional_permissions: ["identity"] },
        { optional_permissions: ["identity.email"] },
        { oauth2: { client_id: "1-a.apps.googleusercontent.com" } },
      ]) {
        await writeFile(
          join(chrome, "manifest.json"),
          JSON.stringify({ ...storeManifest, ...grant }),
        );
        await writeFile(
          join(chrome, "background.js"),
          "browser.identity?.launchWebAuthFlow;",
        );
        await expect(scanTargets([target], root)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "embedded-google-auth-flow" }),
          ]),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing or known-invalid Chrome backend origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-backend-scan-"));
    const background = join(root, ".output", "chrome-mv3", "background.js");
    const target = join(".output", "chrome-mv3", "background.js");
    try {
      await mkdir(join(root, ".output", "chrome-mv3"), { recursive: true });
      await expect(validateChromeBackendBundle(root)).resolves.toEqual([
        { path: target, id: "missing-chrome-background", count: 1 },
      ]);

      await writeFile(background, 'const backend = "https://wrong.example";');
      await expect(validateChromeBackendBundle(root)).resolves.toEqual([]);

      await writeFile(background, 'const backend = "https://backend.invalid";');
      const invalidFindings = await validateChromeBackendBundle(root);
      expect(invalidFindings).toEqual([
        { path: target, id: "invalid-staging-backend-origin", count: 1 },
      ]);
      expect(JSON.stringify(invalidFindings)).not.toContain("backend.invalid");

      await writeFile(
        background,
        'const backend = "https://api.example.test";',
      );
      await expect(validateChromeBackendBundle(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest key only in Store package scans", async () => {
    expect(
      validateStoreManifest(JSON.stringify({ manifest_version: 3 })),
    ).toEqual([]);
    expect(
      validateStoreManifest(JSON.stringify({ manifest_version: 3, key: "k" })),
    ).toEqual([{ id: "store-manifest-key", count: 1 }]);
    expect(validateStoreManifest("{")).toEqual([
      { id: "invalid-store-manifest-json", count: 1 },
    ]);

    const root = await mkdtemp(join(tmpdir(), "release-store-scan-"));
    const target = join(".output", "store", "chrome-mv3");
    const manifest = join(root, target, "manifest.json");
    try {
      await mkdir(join(root, target), { recursive: true });
      await writeFile(
        manifest,
        JSON.stringify({ manifest_version: 3, key: "committed-dev-key" }),
      );
      await expect(scanTargets([target], root)).resolves.toEqual([]);
      const findings = await scanTargets([target], root, { store: true });
      expect(findings).toEqual([
        {
          path: join(target, "manifest.json"),
          id: "store-manifest-key",
          count: 1,
        },
      ]);
      expect(JSON.stringify(findings)).not.toContain("committed-dev-key");

      await writeFile(manifest, JSON.stringify({ manifest_version: 3 }));
      await expect(
        scanTargets([target], root, { store: true }),
      ).resolves.toEqual([]);
      await writeFile(
        join(root, target, "background.js"),
        'const backend = "https://api.example.test";',
      );
      await expect(
        validateChromeBackendBundle(root, join(target, "background.js")),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dev-only manifest capabilities separately", () => {
    expect(
      scanText(
        JSON.stringify({
          content_security_policy:
            "script-src 'self' http://localhost:3001 'unsafe-eval'",
        }),
        { manifest: true },
      ),
    ).toEqual([
      { id: "localhost-script", count: 1 },
      { id: "unsafe-eval", count: 1 },
    ]);
  });
});
