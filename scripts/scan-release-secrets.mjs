import { promises as fs } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const SECRET_PATTERNS = [
  { id: "openai-key", pattern: /sk-(?:proj-)?[0-9A-Za-z_-]{20,}/g },
  { id: "google-key", pattern: /AIza[0-9A-Za-z_-]{20,}/g },
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  {
    id: "oauth-client-secret",
    pattern:
      /(?:GOCSPX-[0-9A-Za-z_-]{16,}|(?:client[_-]?secret|clientSecret)["'`]?\s*[:=]\s*["'`][0-9A-Za-z._~-]{16,}["'`])/gi,
  },
  {
    id: "account-provisioning-token",
    pattern:
      /ACCOUNT_PROVISIONING_TOKEN["'`]?\s*[:=]\s*["'`][0-9A-Za-z+/_-]{32,}={0,2}["'`]/g,
  },
  {
    id: "database-credential",
    pattern: /postgres(?:ql)?:\/\/[^:\s"'`/]+:[^@\s"'`]+@[^\s"'`]+/gi,
  },
  {
    id: "refresh-token",
    pattern:
      /(?:1\/\/[0-9A-Za-z_-]{20,}|(?:refresh[_-]?token|refreshToken)["'`]?\s*[:=]\s*["'`][0-9A-Za-z._~+/-]{16,}["'`])/gi,
  },
];

const BACKEND_URL_PATTERN =
  /\b(?:baseUrl|backendUrl|WXT_BACKEND_URL)["'`]?\s*[:=]\s*["'`](http:\/\/[^\s"'`]+)["'`]/gi;
const LOCAL_BACKEND_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CHROME_BACKGROUND_TARGET = join(".output", "chrome-mv3", "background.js");
const INVALID_STAGING_BACKEND_ORIGIN = "https://backend.invalid";

const DEV_PATTERNS = [
  { id: "localhost-script", pattern: /https?:\/\/localhost:\d+/g },
  { id: "unsafe-eval", pattern: /(?:wasm-)?unsafe-eval/g },
];

const FORBIDDEN_AUTH_MARKERS = [
  {
    id: "native-google-auth-route",
    value: ["/v1/auth/google", "/token"].join(""),
  },
  {
    id: "embedded-google-auth-flow",
    value: ["launchWeb", "AuthFlow"].join(""),
  },
];

// ADR 0015: `identity` and the Google API host are optional, requested at
// Connect Google Workspace; neither may be a required permission.
const WORKSPACE_READER_PERMISSIONS = [
  "tabs",
  "scripting",
  "sidePanel",
  "storage",
];
const WORKSPACE_READER_HOSTS = ["<all_urls>"];
const WORKSPACE_READER_OPTIONAL_PERMISSIONS = ["identity"];
const WORKSPACE_READER_OPTIONAL_HOSTS = ["https://sheets.googleapis.com/*"];

const FORBIDDEN_ARTIFACT_PATHS = [
  {
    id: "obsolete-oauth-artifact",
    pattern:
      /(?:^|\/)backend\/dist\/backend\/src\/auth\/google-(?:web-)?oauth\.js$/i,
  },
  {
    id: "obsolete-credential-artifact",
    pattern:
      /(?:^|\/)backend\/dist\/(?:backend\/src\/credentials|shared\/credential-transport(?:-key)?\.js)(?:\/|$)/i,
  },
];

function scanArtifactPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return FORBIDDEN_ARTIFACT_PATHS.filter(({ pattern }) =>
    pattern.test(normalized),
  ).map(({ id }) => ({ id, count: 1 }));
}

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".html",
  ".css",
  ".map",
  ".yaml",
  ".yml",
]);

export function scanText(text, options = {}) {
  const findings = [];
  for (const { id, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const count = [...text.matchAll(pattern)].length;
    if (count) findings.push({ id, count });
  }
  BACKEND_URL_PATTERN.lastIndex = 0;
  const insecureBackendCount = [...text.matchAll(BACKEND_URL_PATTERN)].filter(
    (match) => {
      try {
        return !LOCAL_BACKEND_HOSTS.has(new URL(match[1]).hostname);
      } catch {
        return true;
      }
    },
  ).length;
  if (insecureBackendCount)
    findings.push({ id: "insecure-backend-url", count: insecureBackendCount });
  const authCounts = new Map();
  for (const { id, value } of FORBIDDEN_AUTH_MARKERS) {
    if (id === "embedded-google-auth-flow" && options.allowWorkspaceWebAuth)
      continue;
    const count = text.split(value).length - 1;
    if (count) authCounts.set(id, (authCounts.get(id) ?? 0) + count);
  }
  for (const [id, count] of authCounts) findings.push({ id, count });
  if (options.manifest) {
    for (const { id, pattern } of DEV_PATTERNS) {
      pattern.lastIndex = 0;
      const count = [...text.matchAll(pattern)].length;
      if (count) findings.push({ id, count });
    }
  }
  return findings;
}

function workspaceReaderAuthMode(manifest, browser) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return undefined;
  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions
    : [];
  const optionalPermissions = Array.isArray(manifest.optional_permissions)
    ? manifest.optional_permissions
    : [];
  const optionalHosts = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
  const exactSet = (actual, expected) =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value));
  const exactReader =
    browser === "chrome" &&
    manifest.manifest_version === 3 &&
    exactSet(permissions, WORKSPACE_READER_PERMISSIONS) &&
    exactSet(optionalPermissions, WORKSPACE_READER_OPTIONAL_PERMISSIONS) &&
    exactSet(manifest.host_permissions, WORKSPACE_READER_HOSTS) &&
    exactSet(optionalHosts, WORKSPACE_READER_OPTIONAL_HOSTS) &&
    manifest.side_panel &&
    typeof manifest.side_panel === "object" &&
    !Array.isArray(manifest.side_panel) &&
    Object.keys(manifest.side_panel).length === 1 &&
    manifest.side_panel.default_path === "/reader.html";
  if (!exactReader) return undefined;
  return Object.hasOwn(manifest, "oauth2") ? undefined : "web";
}

export function validateAuthManifest(text, browser) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [{ id: `invalid-${browser}-manifest-json`, count: 1 }];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return [{ id: `invalid-${browser}-manifest-json`, count: 1 }];

  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions
    : [];
  const optionalPermissions = Array.isArray(manifest.optional_permissions)
    ? manifest.optional_permissions
    : [];
  const hasOauth = Object.hasOwn(manifest, "oauth2");
  const hasIdentity =
    permissions.includes("identity") ||
    optionalPermissions.includes("identity");
  if (workspaceReaderAuthMode(manifest, browser)) return [];

  const findings = [];
  if (hasOauth) findings.push({ id: `${browser}-oauth2-leakage`, count: 1 });
  if (hasIdentity)
    findings.push({ id: `${browser}-identity-permission-leakage`, count: 1 });
  return findings;
}

/**
 * Chrome Web Store packages carry no manifest `key`; the Store assigns the
 * extension ID (ADR 0016).
 */
export function validateStoreManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [{ id: "invalid-store-manifest-json", count: 1 }];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return [{ id: "invalid-store-manifest-json", count: 1 }];
  return Object.hasOwn(manifest, "key")
    ? [{ id: "store-manifest-key", count: 1 }]
    : [];
}

/**
 * A Chromium package whose manifest can never grant `identity` (neither
 * required nor optional, and no `oauth2`) leaves the shared Reader auth code
 * inert: `chrome.identity` does not exist, so `launchWebAuthFlow` cannot run.
 * Store builds ship this way without the Workspace client ID while the remote
 * Sheets Reader flag is off (ADR 0015). Firefox compiles the code out, so the
 * marker stays forbidden there, and secret patterns are never relaxed.
 */
function inertChromiumAuthManifest(manifest, browser) {
  if (
    browser !== "chrome" ||
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.manifest_version !== 3 ||
    Object.hasOwn(manifest, "oauth2")
  )
    return false;
  const grants = [manifest.permissions, manifest.optional_permissions].flatMap(
    (value) => (Array.isArray(value) ? value : []),
  );
  return !grants.some(
    (permission) =>
      typeof permission === "string" && permission.startsWith("identity"),
  );
}

/** Whether the Workspace web auth marker is allowed in this package. */
function allowsWorkspaceWebAuth(text, browser) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    (browser === "chrome" &&
      workspaceReaderAuthMode(manifest, browser) === "web") ||
    inertChromiumAuthManifest(manifest, browser)
  );
}

function releaseBrowser(target) {
  const normalized = target.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("chrome-mv3") || normalized.endsWith("-chrome.zip"))
    return "chrome";
  if (
    normalized.includes("firefox-mv2") ||
    normalized.endsWith("-firefox.zip") ||
    normalized.endsWith(".xpi")
  )
    return "firefox";
  return undefined;
}

export async function validateRequiredTargets(targets, root = process.cwd()) {
  if (!targets.length)
    return [{ path: ".", id: "no-release-targets", count: 1 }];
  const findings = [];
  for (const target of targets) {
    const value = await fs.stat(resolve(root, target)).catch(() => undefined);
    if (!value)
      findings.push({ path: target, id: "missing-release-target", count: 1 });
    else if (value.isFile() && value.size === 0)
      findings.push({ path: target, id: "empty-release-target", count: 1 });
  }
  return findings;
}

export async function validateChromeBackendBundle(
  root = process.cwd(),
  target = CHROME_BACKGROUND_TARGET,
) {
  const text = await fs
    .readFile(resolve(root, target), "utf8")
    .catch(() => undefined);
  if (text === undefined)
    return [
      {
        path: target,
        id: "missing-chrome-background",
        count: 1,
      },
    ];

  const findings = [];
  if (!/https:\/\/[a-z0-9.-]+(?::\d+)?/i.test(text))
    findings.push({
      path: target,
      id: "missing-secure-backend-origin",
      count: 1,
    });
  const invalidCount = text.split(INVALID_STAGING_BACKEND_ORIGIN).length - 1;
  if (invalidCount)
    findings.push({
      path: target,
      id: "invalid-staging-backend-origin",
      count: invalidCount,
    });
  return findings;
}

async function walk(path) {
  const value = await fs.stat(path).catch(() => undefined);
  if (!value) return [];
  if (value.isFile()) return [path];
  const entries = await fs.readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? walk(join(path, entry.name))
          : [join(path, entry.name)],
      ),
    )
  ).flat();
}

function openZip(path, fromBuffer) {
  return new Promise((resolveZip, reject) => {
    const callback = (error, zip) => (error ? reject(error) : resolveZip(zip));
    if (fromBuffer)
      yauzl.fromBuffer(fromBuffer, { lazyEntries: true }, callback);
    else yauzl.open(path, { lazyEntries: true }, callback);
  });
}

function readEntry(zip, entry) {
  return new Promise((resolveEntry, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolveEntry(Buffer.concat(chunks)));
    });
  });
}

async function scanZip(path, buffer, browser, options = {}) {
  const zip = await openZip(path, buffer);
  const findings = [];
  const textEntries = [];
  await new Promise((resolveScan, reject) => {
    zip.on("error", reject);
    zip.on("end", resolveScan);
    zip.on("entry", async (entry) => {
      try {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        for (const finding of scanArtifactPath(entry.fileName))
          findings.push({ path: `${path}!/${entry.fileName}`, ...finding });
        const extension = extname(entry.fileName).toLowerCase();
        if (!TEXT_EXTENSIONS.has(extension) && extension !== ".pem")
          return zip.readEntry();
        const content = await readEntry(zip, entry);
        const text = content.toString("utf8");
        const isManifest = basename(entry.fileName) === "manifest.json";
        textEntries.push({ entryName: entry.fileName, text, isManifest });
        zip.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zip.readEntry();
  });
  zip.close();
  const manifestEntry = textEntries.find(({ isManifest }) => isManifest);
  const allowWorkspaceWebAuth = Boolean(
    (manifestEntry && allowsWorkspaceWebAuth(manifestEntry.text, browser)) ||
    (!browser &&
      path.replaceAll("\\", "/").endsWith("-sources.zip") &&
      options.allowWorkspaceWebAuth),
  );
  for (const entry of textEntries) {
    for (const finding of scanText(entry.text, {
      manifest: entry.isManifest,
      allowWorkspaceWebAuth,
    }))
      findings.push({ path: `${path}!/${entry.entryName}`, ...finding });
    if (browser && entry.isManifest)
      for (const finding of validateAuthManifest(entry.text, browser))
        findings.push({ path: `${path}!/${entry.entryName}`, ...finding });
    if (options.store && browser === "chrome" && entry.isManifest)
      for (const finding of validateStoreManifest(entry.text))
        findings.push({ path: `${path}!/${entry.entryName}`, ...finding });
  }
  if (browser && !manifestEntry)
    findings.push({ path, id: `missing-${browser}-manifest`, count: 1 });
  return findings;
}

async function crxZipBuffer(path) {
  const bytes = await fs.readFile(path);
  if (bytes.subarray(0, 4).toString("ascii") !== "Cr24")
    throw new Error(`Unsupported CRX header: ${path}`);
  const version = bytes.readUInt32LE(4);
  if (version !== 3) throw new Error(`Unsupported CRX version: ${version}`);
  const headerLength = bytes.readUInt32LE(8);
  return bytes.subarray(12 + headerLength);
}

export async function scanTargets(targets, root = process.cwd(), options = {}) {
  const findings = [];
  for (const target of targets) {
    const absolute = resolve(root, target);
    const extension = extname(absolute).toLowerCase();
    const browser = releaseBrowser(target);
    if (extension === ".zip" || extension === ".xpi") {
      findings.push(
        ...(await scanZip(
          relative(root, absolute),
          undefined,
          browser,
          options,
        )),
      );
      continue;
    }
    if (extension === ".crx") {
      findings.push(
        ...(await scanZip(
          relative(root, absolute),
          await crxZipBuffer(absolute),
          browser,
          options,
        )),
      );
      continue;
    }
    const files = await walk(absolute);
    const rootManifestText = browser
      ? await fs
          .readFile(resolve(absolute, "manifest.json"), "utf8")
          .catch(() => undefined)
      : undefined;
    const allowWorkspaceWebAuth = Boolean(
      rootManifestText && allowsWorkspaceWebAuth(rootManifestText, browser),
    );
    let manifestFound = false;
    for (const file of files) {
      const artifactPath = relative(root, file);
      for (const finding of scanArtifactPath(artifactPath))
        findings.push({ path: artifactPath, ...finding });
      const fileExtension = extname(file).toLowerCase();
      if (!TEXT_EXTENSIONS.has(fileExtension) && fileExtension !== ".pem")
        continue;
      const text = await fs.readFile(file, "utf8");
      const isManifest = basename(file) === "manifest.json";
      for (const finding of scanText(text, {
        manifest: isManifest,
        allowWorkspaceWebAuth,
      }))
        findings.push({ path: artifactPath, ...finding });
      if (browser && isManifest) {
        manifestFound = true;
        for (const finding of validateAuthManifest(text, browser))
          findings.push({ path: relative(root, file), ...finding });
        if (options.store && browser === "chrome")
          for (const finding of validateStoreManifest(text))
            findings.push({ path: relative(root, file), ...finding });
      }
    }
    if (browser && !manifestFound)
      findings.push({
        path: target,
        id: `missing-${browser}-manifest`,
        count: 1,
      });
  }
  return findings;
}

const STORE_OUTPUT = join(".output", "store");

/** `--store`: scan the Chrome Web Store package from `pnpm zip:store`. */
async function mainStore(root) {
  const { version } = JSON.parse(
    await fs.readFile(resolve(root, "package.json"), "utf8"),
  );
  const candidates = [
    join(STORE_OUTPUT, "chrome-mv3"),
    join(STORE_OUTPUT, `readlace-${version}-chrome.zip`),
  ];
  return [
    ...(await validateRequiredTargets(candidates, root)),
    ...(await validateChromeBackendBundle(
      root,
      join(STORE_OUTPUT, "chrome-mv3", "background.js"),
    )),
    ...(await scanTargets(
      (
        await Promise.all(
          candidates.map(async (candidate) =>
            (await fs.stat(resolve(root, candidate)).catch(() => undefined))
              ? candidate
              : undefined,
          ),
        )
      ).filter(Boolean),
      root,
      { store: true },
    )),
  ];
}

async function main() {
  const root = process.cwd();
  if (process.argv.includes("--store")) {
    const findings = await mainStore(root);
    for (const finding of findings)
      console.error(`${finding.path}: ${finding.id} (${finding.count})`);
    if (findings.length) process.exitCode = 1;
    else console.log("PASS scanned the Store package; zero secret/dev matches");
    return;
  }
  const candidates = [
    ".output/chrome-mv3",
    ".output/firefox-mv2",
    ".output/readlace-0.0.1-chrome.zip",
    ".output/readlace-0.0.1-firefox.zip",
    ".output/readlace-0.0.1-sources.zip",
  ];
  const requiredFindings = await validateRequiredTargets(candidates, root);
  const existing = [];
  for (const candidate of candidates)
    if (await fs.stat(resolve(root, candidate)).catch(() => undefined))
      existing.push(candidate);
  const chromeManifestText = await fs
    .readFile(resolve(root, ".output/chrome-mv3/manifest.json"), "utf8")
    .catch(() => undefined);
  // Governs only the `-sources.zip` (no manifest of its own).
  const allowWorkspaceWebAuth =
    chromeManifestText !== undefined &&
    allowsWorkspaceWebAuth(chromeManifestText, "chrome");
  const findings = [
    ...requiredFindings,
    ...(await validateChromeBackendBundle(root)),
    ...(await scanTargets(existing, root, { allowWorkspaceWebAuth })),
  ];
  if (findings.length) {
    for (const finding of findings)
      console.error(`${finding.path}: ${finding.id} (${finding.count})`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS scanned ${existing.length} release target(s); zero secret/dev matches`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
