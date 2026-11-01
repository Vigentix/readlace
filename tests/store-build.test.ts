// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROMIUM_EXTENSION_PUBLIC_KEY,
  chromiumManifestKey,
  isStoreBuild,
} from "@/shared/auth-identity";
// @ts-expect-error The Store build wrapper is a directly executable ESM CLI.
import * as storeBuild from "@/scripts/store-build.mjs";

const { storeBuildEnv } = storeBuild;
const STORE_PUBLIC_KEY = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A${"Q".repeat(300)}IDAQAB`;

interface ManifestFactory {
  outDir?: string;
  manifest: (env: {
    browser: string;
    manifestVersion: number;
    mode: string;
    command: string;
  }) => Record<string, unknown>;
}

async function loadWxtConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { default: config } = (await import("@/wxt.config")) as {
    default: ManifestFactory;
  };
  return config;
}

const chrome = {
  browser: "chrome",
  manifestVersion: 3,
  mode: "production",
  command: "build",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Chrome Web Store build (ADR 0016)", () => {
  it("recognizes the Store build flag", () => {
    expect(isStoreBuild({})).toBe(false);
    expect(isStoreBuild({ READLACE_STORE_BUILD: "" })).toBe(false);
    expect(isStoreBuild({ READLACE_STORE_BUILD: "0" })).toBe(false);
    expect(isStoreBuild({ READLACE_STORE_BUILD: "1" })).toBe(true);
    expect(isStoreBuild({ READLACE_STORE_BUILD: " TRUE " })).toBe(true);
    expect(storeBuildEnv({ WXT_SHEETS_READER: "true" })).toEqual({
      WXT_SHEETS_READER: "true",
      READLACE_STORE_BUILD: "1",
    });
  });

  it("omits the key for the Store and keeps a configurable dev key", () => {
    expect(chromiumManifestKey({ READLACE_STORE_BUILD: "1" })).toBeUndefined();
    expect(
      chromiumManifestKey({
        READLACE_STORE_BUILD: "1",
        WXT_EXTENSION_PUBLIC_KEY: STORE_PUBLIC_KEY,
      }),
    ).toBeUndefined();
    expect(chromiumManifestKey({})).toBe(CHROMIUM_EXTENSION_PUBLIC_KEY);
    expect(chromiumManifestKey({ WXT_EXTENSION_PUBLIC_KEY: "  " })).toBe(
      CHROMIUM_EXTENSION_PUBLIC_KEY,
    );
    expect(
      chromiumManifestKey({
        WXT_EXTENSION_PUBLIC_KEY: ` ${STORE_PUBLIC_KEY.slice(0, 100)}\n${STORE_PUBLIC_KEY.slice(100)} `,
      }),
    ).toBe(STORE_PUBLIC_KEY);
    for (const value of ["not-a-key", "-----BEGIN PUBLIC KEY-----", "abc="])
      expect(() =>
        chromiumManifestKey({ WXT_EXTENSION_PUBLIC_KEY: value }),
      ).toThrow("WXT_EXTENSION_PUBLIC_KEY must be the base64 public key");
  });

  it("generates a Store manifest without key into a separate output directory", async () => {
    const config = await loadWxtConfig({
      READLACE_STORE_BUILD: "1",
      WXT_EXTENSION_PUBLIC_KEY: STORE_PUBLIC_KEY,
      WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: "",
      WXT_GOOGLE_WORKSPACE_CLIENT_ID: "",
    });
    expect(config.outDir).toBe(".output/store");
    const manifest = config.manifest(chrome);
    expect(manifest).not.toHaveProperty("key");
    expect(manifest).toMatchObject({
      name: "__MSG_extName__",
      default_locale: "en",
      incognito: "not_allowed",
    });
  });

  it("keeps the committed key in dev builds unless the Store public key is configured", async () => {
    const env = {
      READLACE_STORE_BUILD: "",
      WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: "",
      WXT_GOOGLE_WORKSPACE_CLIENT_ID: "",
    };
    const dev = await loadWxtConfig({ ...env, WXT_EXTENSION_PUBLIC_KEY: "" });
    expect(dev.outDir).toBeUndefined();
    expect(dev.manifest(chrome).key).toBe(CHROMIUM_EXTENSION_PUBLIC_KEY);

    const parity = await loadWxtConfig({
      ...env,
      WXT_EXTENSION_PUBLIC_KEY: STORE_PUBLIC_KEY,
    });
    expect(parity.manifest(chrome).key).toBe(STORE_PUBLIC_KEY);
    expect(
      parity.manifest({ ...chrome, browser: "firefox", manifestVersion: 2 }),
    ).not.toHaveProperty("key");
  });
});
