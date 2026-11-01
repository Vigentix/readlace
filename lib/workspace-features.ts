/**
 * The native Sheets Reader is a build-time choice (ADR 0020, replacing the
 * ADR 0015 remote flag): off unless the build sets `WXT_SHEETS_READER=true`,
 * so the published build ships it only after Google OAuth verification.
 */
export function sheetsReaderEnabled(
  value: string | undefined = import.meta.env.WXT_SHEETS_READER,
) {
  return value?.trim() === "true";
}

/** Popup → background read of the Sheets Reader flag; unreadable = off. */
export function readSheetsReaderFlag(): Promise<boolean> {
  return browser.runtime.sendMessage({ type: "WORKSPACE_FEATURES" }).then(
    (response: unknown) =>
      (response as { workspaceSheetsReader?: unknown } | undefined)
        ?.workspaceSheetsReader === true,
    () => false,
  );
}

/**
 * The Drive Office workbook path needs a Drive scope. The launch scope has
 * only `spreadsheets.readonly`, so the path stays off until Drive returns via
 * `drive.file` and Google Picker (ADR 0015). The code is kept and tested.
 */
export function driveOfficeReaderEnabled() {
  return false;
}

// Launch notice copy (ADR 0015) lives in the UI catalogs:
// `notice.sheetsComingSoon`, `notice.sheetsDownloadSteps` and
// `notice.officeDownloadRequired` (`lib/i18n/catalog/common.*.ts`).
export const LOCAL_READER_PATH = "/reader.html?local=1";
