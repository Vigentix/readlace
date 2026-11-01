/**
 * The page a browser opens after the user removes Readlace (ADR 0020): a
 * static survey, configured at build time with `WXT_UNINSTALL_SURVEY_URL`.
 * Only a plain HTTPS address is accepted, with no query, fragment or
 * credentials, so nothing can identify the user; forks leave it unset and no
 * page opens.
 */
export function parseUninstallSurveyUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return undefined;
  return url.href;
}

export async function installUninstallSurvey(
  runtime: { setUninstallURL?: (url: string) => Promise<void> | void },
  configured: string | undefined,
) {
  const url = parseUninstallSurveyUrl(configured);
  if (!url || typeof runtime.setUninstallURL !== "function") return;
  try {
    await runtime.setUninstallURL(url);
  } catch {
    // Browsers without uninstall pages (or test hosts) simply skip it.
  }
}
