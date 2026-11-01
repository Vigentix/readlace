/**
 * Strings shared by more than one surface (popup, Reader, selection panel):
 * language and plan names, session notices, billing and launch notices.
 */
export const commonEn = {
  "language.en": "English",
  "language.vi": "Vietnamese",
  "language.ja": "Japanese",
  "language.unknown": "Unknown",

  "session.unavailable": "Cannot verify your session. Try again.",
  "session.changed": "Your session changed. Try again.",

  "notice.onDeviceUnsupported":
    "On-device translation requires Chrome 138+ desktop.",
  "notice.sheetsComingSoon": "Reading Google Sheets directly is coming soon.",
  "notice.sheetsDownloadSteps":
    "File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  "notice.officeDownloadRequired":
    "This Excel workbook is stored in Google Drive, which Reader cannot open yet.",
} as const;
