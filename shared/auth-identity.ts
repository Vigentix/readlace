export const CHROMIUM_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy0Eh2bRFAh4NWBhtxVa7lJGuHPA5RjDZcJgVjK2l2zxi3bKa2iw623LMjT6ignrYgAMwgeG28ik0HNVIfG2WLVcPplZOxT62jMYrhfpXOD37ab2zg94AThY7J7/EKJCsFrU085Xp0YSEpojCJHRWnbMZNEokZDVU00mbV9CMDudsb9vZ/E+UHpDch9Tg18aQ+B7RyCgkF3F8cAXEl0lCD+EcDXVLUuZmpBtooPCQTbbnXvbR3Jyypfrm3N5m17nMrGGf1VcE9gVQ0l1Ffz3jUgs6BoAUudfD5Yi1SyRyEJnGZy3dVHLbKTqXM6asEqAOGtNS2W9qwqw++quoF7N34wIDAQAB";

export const CHROMIUM_EXTENSION_ID =
  "imlhpiikjakgljngkdalbfgdpkniejdb" as const;

/**
 * Set by `pnpm build:store` / `pnpm zip:store` (ADR 0016). A Store package
 * carries no manifest `key`: the Chrome Web Store assigns the ID.
 */
export const STORE_BUILD_ENV = "READLACE_STORE_BUILD";
/**
 * Optional dev-build override: the Store item's public key, so an unpacked
 * dev build gets the same ID as the published item.
 */
export const EXTENSION_PUBLIC_KEY_ENV = "WXT_EXTENSION_PUBLIC_KEY";
/** WXT output base for Store builds, separate from the unpacked dev build. */
export const STORE_OUTPUT_DIR = ".output/store";

type BuildEnv = Readonly<Record<string, string | undefined>>;

const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{200,}={0,2}$/;

export function isStoreBuild(env: BuildEnv): boolean {
  const value = env[STORE_BUILD_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * The Chromium manifest `key` for this build: none for the Store, otherwise
 * `WXT_EXTENSION_PUBLIC_KEY` when set, else the committed development key.
 */
export function chromiumManifestKey(
  env: BuildEnv,
  storeBuild = isStoreBuild(env),
): string | undefined {
  if (storeBuild) return undefined;
  const configured = env[EXTENSION_PUBLIC_KEY_ENV]?.replace(/\s+/g, "");
  if (!configured) return CHROMIUM_EXTENSION_PUBLIC_KEY;
  if (!PUBLIC_KEY_PATTERN.test(configured))
    throw new Error(
      `${EXTENSION_PUBLIC_KEY_ENV} must be the base64 public key from the Chrome Web Store Developer Dashboard`,
    );
  return configured;
}
