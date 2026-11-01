import { readFile } from "node:fs/promises";

const BASE_PERMISSIONS = ["tabs", "scripting"];
const READER_PERMISSIONS = ["sidePanel", "storage"];
const BASE_HOST_PERMISSIONS = ["<all_urls>"];
// ADR 0015: Google access is optional and requested at Connect.
const READER_OPTIONAL_PERMISSIONS = ["identity"];
const READER_OPTIONAL_HOST_PERMISSIONS = ["https://sheets.googleapis.com/*"];
const CLIENT_ID_PATTERN = /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/;

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/**
 * `options.store` verifies a Chrome Web Store package (`pnpm build:store`,
 * `.output/store/`, ADR 0016): the Store assigns the extension ID, so the
 * manifest `key` must be absent. Unpacked internal Chromium builds keep the
 * key for a stable extension ID. Firefox has no Store variant here.
 */
export function verifyWorkspaceReaderManifest(
  manifest,
  mode,
  expectedClientId,
  { store = false } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a JSON object");
  }
  if (!new Set(["disabled", "enabled-web", "firefox"]).has(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  if (store && mode === "firefox") {
    throw new Error("the Store variant applies to Chromium manifests only");
  }

  const enabled = mode === "enabled-web";
  const firefox = mode === "firefox";
  const expectedPermissions = firefox
    ? [...BASE_PERMISSIONS, ...BASE_HOST_PERMISSIONS]
    : enabled
      ? [...BASE_PERMISSIONS, ...READER_PERMISSIONS]
      : BASE_PERMISSIONS;
  const expectedHosts = BASE_HOST_PERMISSIONS;
  const errors = [];

  if (
    enabled &&
    (!expectedClientId || !CLIENT_ID_PATTERN.test(expectedClientId))
  ) {
    errors.push("a valid portable Web OAuth client ID is required");
  }

  if (!sameArray(manifest.permissions, expectedPermissions)) {
    errors.push(
      `permissions must equal ${JSON.stringify(expectedPermissions)}`,
    );
  }
  if (firefox) {
    if (Object.hasOwn(manifest, "host_permissions")) {
      errors.push("Firefox host_permissions must be absent");
    }
  } else if (!sameArray(manifest.host_permissions, expectedHosts)) {
    errors.push(`host_permissions must equal ${JSON.stringify(expectedHosts)}`);
  }

  if (enabled) {
    if (
      !sameArray(manifest.optional_permissions, READER_OPTIONAL_PERMISSIONS)
    ) {
      errors.push(
        `optional_permissions must equal ${JSON.stringify(READER_OPTIONAL_PERMISSIONS)}`,
      );
    }
    if (
      !sameArray(
        manifest.optional_host_permissions,
        READER_OPTIONAL_HOST_PERMISSIONS,
      )
    ) {
      errors.push(
        `optional_host_permissions must equal ${JSON.stringify(READER_OPTIONAL_HOST_PERMISSIONS)}`,
      );
    }
  } else {
    for (const key of ["optional_permissions", "optional_host_permissions"])
      if (Object.hasOwn(manifest, key)) errors.push(`${key} must be absent`);
  }

  if (Object.hasOwn(manifest, "oauth2")) errors.push("oauth2 must be absent");
  if (enabled) {
    if (
      !manifest.side_panel ||
      typeof manifest.side_panel !== "object" ||
      Array.isArray(manifest.side_panel) ||
      !sameArray(Object.keys(manifest.side_panel), ["default_path"]) ||
      manifest.side_panel.default_path !== "/reader.html"
    ) {
      errors.push("side_panel must contain only /reader.html as default_path");
    }
  } else {
    if (Object.hasOwn(manifest, "side_panel")) {
      errors.push("side_panel must be absent");
    }
  }

  if (mode === "firefox") {
    if (Object.hasOwn(manifest, "key")) errors.push("key must be absent");
    if (
      manifest.browser_specific_settings?.gecko?.strict_min_version !== "102.0"
    ) {
      errors.push("Firefox strict_min_version must remain 102.0");
    }
  } else if (store) {
    if (Object.hasOwn(manifest, "key")) {
      errors.push("Chrome Web Store manifest key must be absent");
    }
  } else if (typeof manifest.key !== "string" || !manifest.key) {
    errors.push("Chromium public key must remain present");
  }

  if (errors.length) throw new Error(errors.join("\n"));
  return true;
}

const USAGE =
  "usage: node scripts/verify-workspace-reader-manifest.mjs --mode <disabled|enabled-web|firefox> [--store] <manifest-path>";

export async function run(argv = process.argv.slice(2)) {
  // `--store` mirrors `scan-release-secrets.mjs --store`: verify the Chrome
  // Web Store package, whose manifest carries no `key`.
  const store = argv.includes("--store");
  const args = argv.filter((arg) => arg !== "--store");
  if (
    args.length !== 3 ||
    args[0] !== "--mode" ||
    argv.filter((arg) => arg === "--store").length > 1
  ) {
    throw new Error(USAGE);
  }
  const [, mode, manifestPath] = args;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expectedClientId =
    mode === "enabled-web"
      ? process.env.WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID
      : undefined;
  if (
    mode === "enabled-web" &&
    (!expectedClientId || !CLIENT_ID_PATTERN.test(expectedClientId))
  ) {
    throw new Error(
      "WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID is required to verify an enabled manifest",
    );
  }
  verifyWorkspaceReaderManifest(manifest, mode, expectedClientId, { store });
}

if (process.argv[1]?.endsWith("verify-workspace-reader-manifest.mjs")) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
