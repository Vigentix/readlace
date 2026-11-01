const GOOGLE_CLIENT_ID_PATTERN =
  /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/;

export function isGoogleWorkspaceWebClientId(value: string): boolean {
  return GOOGLE_CLIENT_ID_PATTERN.test(value);
}

/**
 * Launch scope (ADR 0015): only the sensitive `spreadsheets.readonly` scope.
 * `documents.readonly` (Docs are unsupported) and the restricted
 * `drive.readonly` (Drive Office workbooks) are not requested.
 */
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;

/**
 * Requested at **Connect Google Workspace**, never at install (ADR 0015), so
 * enabling the Reader later never disables the extension for existing users.
 */
export const GOOGLE_WORKSPACE_OPTIONAL_PERMISSIONS = ["identity"] as const;
export const GOOGLE_WORKSPACE_OPTIONAL_HOST_PERMISSIONS = [
  "https://sheets.googleapis.com/*",
] as const;

// Neither carries an install warning; the Reader needs both before Connect.
const WORKSPACE_PERMISSIONS = ["sidePanel", "storage"];

interface WorkspaceReaderBuildConfig {
  enabled: boolean;
  mode: "disabled" | "web";
  clientId?: string;
  permissions: string[];
  optionalPermissions: string[];
  optionalHostPermissions: string[];
}

export function workspaceReaderBuildConfig(
  env: Readonly<Record<string, string | undefined>>,
  browser: string,
): WorkspaceReaderBuildConfig {
  const nativeClientId = env.WXT_GOOGLE_WORKSPACE_CLIENT_ID;
  const webClientId = env.WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID;
  if (nativeClientId?.trim()) {
    throw new Error(
      "WXT_GOOGLE_WORKSPACE_CLIENT_ID is no longer supported; configure WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID for the portable Chromium Reader",
    );
  }
  if (webClientId?.trim() && !isGoogleWorkspaceWebClientId(webClientId)) {
    throw new Error(
      "WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID must be a Google-generated Web OAuth client ID like 123456789012-name.apps.googleusercontent.com",
    );
  }
  const clientId = webClientId;
  if (!clientId?.trim() || browser === "firefox") {
    return {
      enabled: false,
      mode: "disabled",
      permissions: [],
      optionalPermissions: [],
      optionalHostPermissions: [],
    };
  }

  return {
    enabled: true,
    mode: "web",
    clientId,
    permissions: [...WORKSPACE_PERMISSIONS],
    optionalPermissions: [...GOOGLE_WORKSPACE_OPTIONAL_PERMISSIONS],
    optionalHostPermissions: [...GOOGLE_WORKSPACE_OPTIONAL_HOST_PERMISSIONS],
  };
}
