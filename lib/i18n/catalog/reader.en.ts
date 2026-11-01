/**
 * The spreadsheet Reader shell, local workbooks, the shared toolbar, the grid
 * and the Local Reader plan gate (`entrypoints/reader.sidepanel`).
 */
export const readerEn = {
  "reader.brandSubtitle": "Spreadsheet Reader",
  "reader.localSubtitle": "Local Spreadsheet Reader",
  "reader.driveSubtitle": "Google Drive Spreadsheet Reader",

  // Shared toolbar (SpreadsheetReaderControls), both Readers.
  "reader.controls": "Spreadsheet Reader controls",
  "reader.worksheet": "Worksheet",
  "reader.worksheetPlaceholder": "Select a worksheet",
  "reader.translateTo": "Translate to",
  "reader.loading": "Loading…",
  "reader.primary.translate": "Translate",
  "reader.primary.translating": "Translating…",
  "reader.primary.translationOn": "Translation on",
  "reader.primary.resume": "Resume translation",
  "reader.primary.retryUnresolved": "Retry unresolved",
  "reader.primary.retry": "Retry",
  "reader.stop": "Stop",
  "reader.presentation": "Cell presentation",
  "reader.presentation.translation": "Translation",
  "reader.presentation.original": "Original",
  "reader.refresh": "Refresh",
  "reader.clearView": "Clear view",
  "reader.disconnecting": "Disconnecting…",
  "reader.disconnectGoogle": "Disconnect Google",

  // Source states (SpreadsheetReaderSourceState).
  "reader.sourceState": "Spreadsheet source",
  "reader.phase.bootstrapping": "Preparing Reader…",
  "reader.phase.identifying": "Identifying spreadsheet…",
  "reader.phase.discovering": "Discovering worksheet…",
  "reader.phase.loadingSheet": "Loading worksheet…",
  "reader.phase.awaitingStart": "Ready to read this spreadsheet",
  "reader.phase.empty": "This worksheet has no readable text",
  "reader.phase.error": "Reader could not load this spreadsheet",
  "reader.phase.disconnecting": "Disconnecting Google…",

  // Grid (SheetsGrid).
  "reader.grid.sheet": "{title} sheet",
  "reader.grid.rowNumbers": "Row numbers",
  "reader.grid.hiddenColumn": "Column {column} hidden",
  "reader.grid.blank": "Blank",
  "reader.cell.details": "Selected cell details",
  "reader.cell.source": "Source",
  "reader.cell.displayed": "Displayed result",
  "reader.cell.translation": "Translation",
  "reader.cell.notTranslated": "Not translated",

  // Local Reader plan gate (LocalReaderPlanGate).

  // Local and Drive workbook Reader (LocalSpreadsheetReader).
  "reader.badge.drive": "Drive · read-only",
  "reader.badge.local": "File stays local",
  "reader.source.driveFile": "Google Drive file",
  "reader.source.localFile": "Local file",
  "reader.source.driveWorkbook": "Drive workbook",
  "reader.source.localWorkbook": "Local workbook",
  "reader.worksheetAfterTranslate": "Translate to load worksheets",
  "reader.results.drive": "Google Drive spreadsheet",
  "reader.results.local": "Local spreadsheet",
  "reader.recovery": "Reader connection recovery",
  "reader.openInTab": "Open Reader in a tab",
  "reader.reconnectWorkspace": "Reconnect Google Workspace",
  "reader.local.selection": "Local file selection",
  "reader.local.openInput": "Open local spreadsheet",
  "reader.local.reading": "Reading spreadsheet…",
  "reader.local.choose": "Choose or drop a spreadsheet",
  "reader.local.hint": ".csv, .xlsx, or .xlsm · up to 20 MiB",
  "reader.local.boundaries":
    "File bytes stay on this device and are never uploaded. After you click Translate, only visible cell text is sent to Readlace for translation. Reader is read-only, never runs macros, and supports up to 50 sheets, 100,000 rows, 16,384 columns, 10,000 populated cells and 256,000 characters per sheet. Charts, images, pivots and exact Excel rendering are excluded.",
  "reader.drop.title": "Drop to open this spreadsheet locally",
  "reader.drop.hint": ".csv, .xlsx, or .xlsm · up to 20 MiB · never uploaded",
  "reader.drop.multiple": "Drop one spreadsheet at a time.",
  "reader.desc.awaitingStart":
    "Click Translate to discover and translate the current workbook.",
  "reader.desc.refreshRetry": "Use Refresh to try again.",
  "reader.desc.driveSaved":
    "Reader reads the latest saved workbook. Unsaved editor changes may not be included.",
  "reader.desc.local":
    "Reading this file locally. File bytes remain on this device.",

  "reader.status.chooseFile": "Choose a local spreadsheet to begin.",
  "reader.status.discoveringDrive": "Discovering saved Drive workbook…",
  "reader.status.loadedDrive": "{sheet} loaded from Google Drive.",
  "reader.status.loadedLocal": "{sheet} loaded locally.",
  "reader.status.readingFile": "Reading {name} locally…",
  "reader.status.translatingCells": {
    one: "Translating {count} visible cell…",
    other: "Translating {count} visible cells…",
  },
  "reader.status.slow":
    "Translation is taking longer than 30 seconds. Waiting for the background request to finish.",
  "reader.status.completed": {
    one: "{count} translation completed.",
    other: "{count} translations completed.",
  },
  "reader.status.queued":
    "Translation queued until the previous request finishes.",
  "reader.status.driveCleared":
    "Drive workbook cleared. Refresh to download it again.",
  "reader.status.localCleared": "Local Reader cleared.",
  "reader.status.sourceChanged": "The source tab changed. Reloading Reader…",
  "reader.status.disconnecting": "Disconnecting Google Workspace…",
  "reader.status.settingsChanged":
    "Translation settings changed. Previous results were cleared.",

  "reader.partial.unresolved": {
    one: "{count} cell could not be translated.",
    other: "{count} cells could not be translated.",
  },
  "reader.partial.oversized": {
    one: "{count} cell exceed the 4,000-character translation limit.",
    other: "{count} cells exceed the 4,000-character translation limit.",
  },
  "reader.partial.mixed": {
    one: "{count} cell can be retried; {oversized} exceed the 4,000-character translation limit.",
    other:
      "{count} cells can be retried; {oversized} exceed the 4,000-character translation limit.",
  },

  "reader.error.authRequired":
    "Sign in to your Readlace account in the extension popup.",
  "reader.error.authUnavailable":
    "Readlace account verification is temporarily unavailable.",
  "reader.error.sessionChanged":
    "Your Readlace session changed. Reopen Reader to continue.",
  "reader.error.invalidTranslation":
    "Reader received an invalid translation response.",
  "reader.error.translateFailed": "Reader could not translate these cells.",
  "reader.error.staleTranslation":
    "Reader discarded a stale translation response.",
  "reader.error.disconnectFailed":
    "Google Workspace could not disconnect. Try again.",
  "reader.error.openTabFailed":
    "Reader could not open a tab. Refresh or try opening the Reader tab again.",
  "reader.error.readFailed": "Reader could not read this file.",
  "reader.error.sheetTimeout":
    "Worksheet loading took longer than 15 seconds and was stopped.",
  "reader.error.parseTimeout":
    "Parsing took longer than 15 seconds and was stopped.",

  // `LocalSpreadsheetErrorCode` from the parsing Worker.
  "reader.local.unsupportedFileType": "Choose a .csv, .xlsx, or .xlsm file.",
  "reader.local.fileTooLarge":
    "This file exceeds the 20 MiB local Reader limit.",
  "reader.local.tooManySheets": "This workbook exceeds the 50-sheet limit.",
  "reader.local.dimensionsTooLarge":
    "This sheet exceeds the 100,000-row or 16,384-column limit.",
  "reader.local.contentTooLarge":
    "This sheet exceeds the 10,000-cell or 256,000-character limit.",
  "reader.local.encryptedWorkbook":
    "Encrypted or password-protected workbooks are not supported.",
  "reader.local.invalidWorkbook": "Reader could not parse this spreadsheet.",
  "reader.local.invalidRequest":
    "Reader received an invalid spreadsheet response.",

  // `GoogleDriveOfficeErrorCode` from the Drive download channel.
  "reader.drive.invalidRequest":
    "Reader received an invalid Drive download request.",
  "reader.drive.googleAuthRequired":
    "Reconnect Google Workspace to grant read-only Drive access.",
  "reader.drive.accessDenied":
    "Google denied access. Check consent, administrator policy, and file permissions.",
  "reader.drive.oauthExpired":
    "Google Workspace access expired. Reconnect to continue.",
  "reader.drive.unsupportedFileType":
    "The active Drive file is not an .xlsx or .xlsm workbook.",
  "reader.drive.downloadNotAllowed":
    "The owner or organization does not allow this file to be downloaded.",
  "reader.drive.officeDownloadRequired":
    "This Excel workbook is stored in Google Drive, which Reader cannot open yet. File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  "reader.drive.fileTooLarge":
    "This file exceeds the 20 MiB Drive Reader limit.",
  "reader.drive.downloadTimeout":
    "Downloading from Google Drive took longer than 30 seconds. Refresh to try again.",
  "reader.drive.temporarilyUnavailable":
    "Google Drive is temporarily unavailable. Refresh to try again.",
  "reader.drive.channelUnavailable":
    "Reader could not connect to the extension background. Refresh to try again.",
  "reader.drive.sourceTabChanged":
    "The source tab changed. Return to the active Office file and reopen Reader.",
  "reader.drive.invalidResponse":
    "Reader received an invalid Drive download response.",
} as const;
