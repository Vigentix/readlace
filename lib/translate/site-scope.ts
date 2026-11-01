import { getDomain } from "tldts";
import {
  PREF_PREFIX,
  TARGET_LANGUAGES,
  preferenceKey,
  type AlwaysTranslatePreference,
  type TargetLanguage,
} from "@/lib/translation";

const GET_DOMAIN_OPTIONS = {
  extractHostname: false,
  allowPrivateDomains: true,
} as const;

/** Registrable domain (eTLD+1), or the exact hostname when none exists. */
export function siteScopeFromHostname(hostname: string): string {
  if (!hostname) return hostname;
  const domain = getDomain(hostname, GET_DOMAIN_OPTIONS);
  return domain || hostname;
}

/** Canonical always-translate storage key for a hostname's site scope. */
export function canonicalPreferenceKey(hostname: string): string {
  return preferenceKey(siteScopeFromHostname(hostname));
}

function isTargetLanguage(value: unknown): value is TargetLanguage {
  return TARGET_LANGUAGES.some((language) => language.code === value);
}

function asPreference(value: unknown): AlwaysTranslatePreference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { enabled?: unknown; targetLanguage?: unknown };
  if (typeof candidate.enabled !== "boolean") return undefined;
  if (!isTargetLanguage(candidate.targetLanguage)) return undefined;
  return {
    enabled: candidate.enabled,
    targetLanguage: candidate.targetLanguage,
  };
}

/**
 * Resolves always-translate from a storage record: canonical site-scope key,
 * then exact hostname key, then any other alwaysTranslate:* key with the same site scope.
 */
export function readAlwaysTranslatePreference(
  hostname: string,
  storage: Record<string, unknown>,
): AlwaysTranslatePreference | undefined {
  const canonicalKey = canonicalPreferenceKey(hostname);
  const canonical = asPreference(storage[canonicalKey]);
  if (canonical) return canonical;

  const exactKey = preferenceKey(hostname);
  if (exactKey !== canonicalKey) {
    const exact = asPreference(storage[exactKey]);
    if (exact) return exact;
  }

  const siteScope = siteScopeFromHostname(hostname);
  for (const [key, value] of Object.entries(storage)) {
    if (!key.startsWith(PREF_PREFIX)) continue;
    if (key === canonicalKey || key === exactKey) continue;
    const leftoverHostname = key.slice(PREF_PREFIX.length);
    if (siteScopeFromHostname(leftoverHostname) !== siteScope) continue;
    const preference = asPreference(value);
    if (preference) return preference;
  }
  return undefined;
}
