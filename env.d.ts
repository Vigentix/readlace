interface ImportMetaEnv {
  /** Optional public Google Chrome-extension OAuth client ID. */
  readonly WXT_GOOGLE_WORKSPACE_CLIENT_ID?: string;
  /** Optional public Google Web OAuth client ID for Chromium browsers without native token support. */
  readonly WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID?: string;
  /** Plain HTTPS survey page opened after uninstall (ADR 0020); unset = none. */
  readonly WXT_UNINSTALL_SURVEY_URL?: string;
  /** `true` turns on the native Sheets Reader (ADR 0020); off by default. */
  readonly WXT_SHEETS_READER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
