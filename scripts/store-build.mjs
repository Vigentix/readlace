import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStoreManifest } from "./scan-release-secrets.mjs";

/**
 * Chrome Web Store build (ADR 0016): `node scripts/store-build.mjs build|zip`.
 * Runs WXT with `READLACE_STORE_BUILD=1`, which writes to `.output/store/`
 * and omits the manifest `key` so the Store assigns the extension ID.
 */
export const STORE_BUILD_ENV = "READLACE_STORE_BUILD";
export const STORE_MANIFEST = join(
  ".output",
  "store",
  "chrome-mv3",
  "manifest.json",
);
const COMMANDS = new Set(["build", "zip"]);

export function storeBuildEnv(env) {
  return { ...env, [STORE_BUILD_ENV]: "1" };
}

async function main() {
  const root = process.cwd();
  const command = process.argv[2];
  if (!COMMANDS.has(command)) {
    console.error("Usage: node scripts/store-build.mjs build|zip");
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(
    process.execPath,
    [resolve(root, "node_modules", "wxt", "bin", "wxt.mjs"), command],
    { cwd: root, env: storeBuildEnv(process.env), stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  const text = await readFile(resolve(root, STORE_MANIFEST), "utf8").catch(
    () => undefined,
  );
  const findings =
    text === undefined
      ? [{ id: "missing-store-manifest", count: 1 }]
      : validateStoreManifest(text);
  if (findings.length) {
    for (const finding of findings)
      console.error(`${STORE_MANIFEST}: ${finding.id} (${finding.count})`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${STORE_MANIFEST} has no manifest key`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
