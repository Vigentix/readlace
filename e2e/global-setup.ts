import { readFile } from "node:fs/promises";
import path from "node:path";

/** Public test Web client ID the Workspace Reader specs expect. */
export const DETERMINISTIC_WORKSPACE_CLIENT_ID =
  "123456789012-readlacereader-web.apps.googleusercontent.com";

const BUILD_COMMAND = `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID=${DETERMINISTIC_WORKSPACE_CLIENT_ID} WXT_SHEETS_READER=true pnpm build`;

/**
 * The Reader specs need the Workspace Reader and the native Sheets Reader
 * built in (ADR 0020 build flag). Fail fast instead of failing every spec.
 */
export async function verifyDeterministicBuild(
  extensionPath: string,
  env: NodeJS.ProcessEnv,
) {
  // Live provider runs build against a dedicated backend on purpose.
  if (
    env.RUN_LIVE_PROVIDER_FALLBACK === "1" ||
    env.RUN_LIVE_OPENAI_BENCHMARK === "1"
  )
    return;
  const manifestText = await readFile(
    path.join(extensionPath, "manifest.json"),
    "utf8",
  );
  const problems: string[] = [];
  const manifest = JSON.parse(manifestText) as { side_panel?: unknown };
  if (!manifest.side_panel)
    problems.push("the Workspace Reader is not configured (no side_panel)");
  if (problems.length)
    throw new Error(
      `E2E extension build at ${extensionPath} is not the deterministic build: ${problems.join("; ")}. Rebuild with: ${BUILD_COMMAND}`,
    );
}

export default async function globalSetup() {
  await verifyDeterministicBuild(
    path.resolve(process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3"),
    process.env,
  );
}
