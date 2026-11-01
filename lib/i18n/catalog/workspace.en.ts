/**
 * The Google Workspace Reader (`entrypoints/reader.sidepanel/App.tsx`,
 * `workspace.*`) and the Reader shell (`entrypoints/reader.sidepanel/main.tsx`,
 * `shell.*`).
 */
export const workspaceEn = {
  "workspace.subtitle": "Google Workspace Reader",

  // Error codes from the background (`WorkspaceReaderErrorCode`).
  "workspace.error.notConfigured":
    "Google Workspace Reader is not configured in this build.",
  "workspace.error.unsupportedBrowser":
    "Google Workspace Reader is unavailable in this browser.",
  "workspace.error.unsupportedUrl":
    "Open a native Google Sheet or a supported Drive .xlsx/.xlsm workbook, then reopen Reader. Google Docs is temporarily unsupported.",
  "workspace.error.unsupportedFileType":
    "This file type is not supported. Open a native Google Sheet or a Drive .xlsx/.xlsm workbook.",
  "workspace.error.googleAuthRequired": "Connect Google Workspace to continue.",
  "workspace.error.googleAccessDenied":
    "Google denied access. Check consent and file permissions.",
  "workspace.error.googleOauthConfiguration":
    "Google Workspace authorization is not configured for this browser.",
  "workspace.error.googleOauthResponse":
    "Google returned an invalid authorization response.",
  "workspace.error.googleOauthScope":
    "Google did not grant the required read-only access.",
  "workspace.error.googleOauthExpired":
    "Google Workspace access expired. Reconnect to continue.",
  "workspace.error.googleOauthNetwork":
    "Google authorization could not reach the network.",
  "workspace.error.googleOauthFailed": "Google Workspace authorization failed.",
  // `notice.sheetsComingSoon` + `notice.sheetsDownloadSteps` as one message.
  "workspace.error.sheetsReaderUnavailable":
    "Reading Google Sheets directly is coming soon. File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  // `notice.officeDownloadRequired` + `notice.sheetsDownloadSteps`.
  "workspace.error.officeDownloadRequired":
    "This Excel workbook is stored in Google Drive, which Reader cannot open yet. File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  "workspace.error.googlePermissionDenied":
    "Allow Google access when Chrome asks to connect Google Workspace.",
  "workspace.error.sourceTabChanged":
    "The source tab changed. Refresh Reader to continue.",
  "workspace.error.responseTooLarge":
    "The Google response is too large for Reader.",
  "workspace.error.contentTooLarge":
    "This file exceeds Reader's content limits.",
  "workspace.error.rateLimited":
    "Google is rate limiting this request. Try again later.",
  "workspace.error.temporarilyUnavailable":
    "Google Workspace is temporarily unavailable.",
  "workspace.error.readerChannelUnavailable":
    "Reader cannot verify this panel's source. Open Reader in a tab to continue.",
  "workspace.error.invalidRequest":
    "Reader received an invalid response. Refresh and try again.",
  "workspace.error.authRequired":
    "Sign in to your Readlace account in the extension popup.",
  "workspace.error.authUnavailable":
    "Readlace account verification is temporarily unavailable.",
  "workspace.error.openTabFailed": "Reader could not open in a tab. Try again.",

  // Status lines.
  "workspace.status.loadingReader": "Loading Reader…",
  "workspace.status.discoveringColumns":
    "Discovering columns {scanned}/{total}…",
  "workspace.status.discoveringRows": "Discovering rows {scanned}/{total}…",
  "workspace.status.loadingNextRows": "Loading next 100 rows…",
  "workspace.status.loadingSource": "Loading source…",
  "workspace.status.recordsLoaded": {
    one: "{count} record loaded.",
    other: "{count} records loaded.",
  },
  "workspace.status.discoveryPaused": "Discovery paused.",
  "workspace.status.discoveryStopped": "Discovery stopped.",
  "workspace.status.discoveryComplete": "Column discovery complete.",
  "workspace.status.connected": "Google Workspace connected.",
  "workspace.status.connectToLoad":
    "Connect Google Workspace to load this file.",
  "workspace.status.reconnecting": "Reconnecting Reader…",
  "workspace.status.loadingActiveSource": "Loading active source…",
  "workspace.status.waitingAuthorization": "Waiting for Google authorization…",
  "workspace.status.disconnecting": "Disconnecting Google Workspace…",
  "workspace.status.disconnected": "Google Workspace disconnected.",
  "workspace.status.partial":
    "{translated} translated; {unresolved} unresolved.",
  "workspace.status.translationsCompleted": {
    one: "{count} translation completed.",
    other: "{count} translations completed.",
  },
  "workspace.status.noUntranslatedVisible": "No untranslated text is visible.",
  "workspace.status.selectedTooLarge":
    "Selected content exceeds the per-record translation limit.",
  "workspace.status.noUntranslatedAvailable":
    "No untranslated text is available.",
  "workspace.status.translating": "Translating…",
  "workspace.status.translationsKept": {
    one: "{count} translation kept before the request stopped.",
    other: "{count} translations kept before the request stopped.",
  },
  "workspace.status.viewCleared":
    "Reader view cleared. Source content and saved translations were not changed.",
  "workspace.status.settingsChanged":
    "Translation settings changed. Previous Reader results were cleared.",
  "workspace.status.loadingWorksheet": "Loading worksheet…",

  // Connection badge.
  "workspace.connection.connected": "Connected",
  "workspace.connection.notConnected": "Not connected",
  "workspace.connection.unavailable": "Access unavailable",
  "workspace.connection.checking": "Checking access",

  // Controls.
  "workspace.openingReader": "Opening Reader…",
  "workspace.openInTab": "Open Reader in a tab",
  "workspace.activeSheet": "Active sheet",
  "workspace.documentTab": "Document tab",
  "workspace.notLoaded": "Not loaded",
  "workspace.untitledTab": "Untitled tab",
  "workspace.worksheetUnavailable":
    "Worksheet names unavailable. Refresh to retry.",
  "workspace.continueDiscovery": "Continue discovery",
  "workspace.controls": "Reader controls",
  "workspace.translateTo": "Translate to",
  "workspace.translate": "Translate",
  "workspace.translateLoaded": "Translate loaded",
  "workspace.translateSelected": "Translate selected ({count})",
  "workspace.cellPresentation": "Cell presentation",
  "workspace.presentation.translation": "Translation",
  "workspace.presentation.original": "Original",
  "workspace.refresh": "Refresh",
  "workspace.clearView": "Clear view",
  "workspace.disconnect": "Disconnect",
  "workspace.connect": "Connect Google Workspace",
  "workspace.reconnect": "Reconnect Google Workspace",
  "workspace.openLocalSpreadsheet": "Open local spreadsheet",

  // Results.
  "workspace.results.sheet": "Reader sheet",
  "workspace.results.records": "Reader records",
  "workspace.record.select": "Select {anchor}",
  "workspace.record.formula": "Formula",
  "workspace.record.error": "Error",
  "workspace.record.nonText": "Non-text",
  "workspace.record.tooLarge": "Too large",
  "workspace.record.translationFailed": "Translation failed",
  "workspace.record.unresolved": "Unresolved",
  "workspace.record.source": "Source",
  "workspace.record.displayedValue": "Displayed value: {value}",
  "workspace.record.translation": "Translation",
  "workspace.empty.readyToRead": "Ready to read this spreadsheet",
  "workspace.empty.connectToRead":
    "Connect Google Workspace to read this file.",
  "workspace.empty.clickTranslate":
    "Click Translate to discover and translate this file.",

  // Reader shell (`main.tsx`).
  "shell.documentTitle": "Readlace Reader",
  "shell.loadingSource": "Loading source",
  "shell.notLoaded": "Not loaded",
  "shell.cannotVerifySource":
    "Reader cannot verify this panel's source. Open Reader in a tab to continue.",
  "shell.openSupportedSpreadsheet":
    "Open a supported spreadsheet and click the extension icon to continue.",
  "shell.openTabFailed": "Reader could not open in a tab. Try again.",
  "shell.openingReader": "Opening Reader…",
  "shell.openInTab": "Open Reader in a tab",
} as const;
