/** The toolbar popup (`entrypoints/popup`). */
export const popupEn = {
  loading: "Loading popup…",

  "settings.open": "Settings",
  "engine.onDevice":
    "Translating on-device. Add your OpenAI API key in Settings for AI translation.",
  "engine.keyRejected":
    "OpenAI rejected your API key. Translating on-device; check the key in Settings.",
  "account.menu": "Menu",
  "account.clearSaved": "Clear saved translations",
  "language.label": "Language",

  "page.card": "This page",
  "page.detectedLanguage": "Detected language",
  "page.translateTo": "Translate to",
  "page.sheetsInPlace": "Google Sheets can’t be translated in place yet.",
  "page.serviceUnavailable": "Translation service is unavailable.",
  "page.always": "Always translate this site",
  "page.statusTranslated": "Translated to {language}",
  "page.statusPartial": "Partly translated.",
  "page.translateRest": "Translate the rest",
  "page.statusOriginal": "Showing the original",

  "unavailable.page": "Translation is unavailable on this page.",
  "unavailable.docs": "Google Docs is temporarily unsupported.",
  "unavailable.readerNotConfigured":
    "Google Workspace Reader is not configured in this build.",
  "unavailable.readerBrowser":
    "Google Workspace Reader is unavailable in this browser.",
  "unavailable.toolsFailed":
    "Translation tools could not be loaded on this page.",

  "translate.button": "Translate",
  "translate.translateTo": "Translate to {language}",
  "translate.translation": "Translation",
  "translate.showTranslation": "Show translation",
  "translate.stop": "Stop",
  "translate.stopLabel": "Stop translating and show the original",
  "translate.opening": "Opening…",
  "translate.preparing": "Preparing…",
  "translate.translating": "Translating…",
  "translate.retry": "Try again",
  "translate.view": "Page view",
  "translate.original": "Original",
  "translate.showOriginal": "Show original",
  "translate.checkingSession": "Checking your session…",
  "translate.freeBlocked": "Needs an API key to translate in this browser.",

  "native.downloading": "Downloading on-device language pack…",
  "native.downloadingPercent": "Downloading on-device language pack {percent}%",
  "native.progress": "On-device language pack download",

  "status.translateFailed": "Couldn’t translate this page. Try again.",
  "status.readerOpenFailed": "Could not open Google Workspace Reader.",
  "status.originalRestored": "Original restored.",
  "status.translationStopped":
    "Translation stopped. The page is back to the original.",
  "status.cannotTranslate": "This page cannot be translated",
  "status.clearConfirm":
    "Clear saved translations? Your site preferences will stay saved.",
  "status.clearing": "Clearing saved translations…",
  "status.cleared": "Saved translations cleared.",
  "status.clearFailed": "Could not clear saved translations.",
  "status.localReaderFailed":
    "Could not open the local spreadsheet reader. Try again.",

  "tools.section": "Spreadsheet tools",
  "tools.open": "Open local spreadsheet",
  "tools.opening": "Opening local spreadsheet…",
  "tools.hint": "CSV, XLSX or XLSM · stays on this device",

  "notice.onDevice": "On-device translation",
  "notice.onDeviceAddKey":
    "Add your OpenAI API key in Settings to translate in this browser.",
  "notice.sheets": "Google Sheets",
} as const;
