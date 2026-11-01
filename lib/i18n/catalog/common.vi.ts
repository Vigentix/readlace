import type { Translation } from "@/lib/i18n/core";
import type { commonEn } from "@/lib/i18n/catalog/common.en";

export const commonVi: Translation<typeof commonEn> = {
  "language.en": "Tiếng Anh",
  "language.vi": "Tiếng Việt",
  "language.ja": "Tiếng Nhật",
  "language.unknown": "Chưa rõ",

  "session.unavailable": "Không xác minh được phiên đăng nhập. Hãy thử lại.",
  "session.changed": "Phiên đăng nhập vừa thay đổi. Hãy thử lại.",

  "notice.onDeviceUnsupported":
    "Dịch trên máy cần Chrome 138 trở lên trên máy tính.",
  "notice.sheetsComingSoon": "Sắp có tính năng đọc trực tiếp Google Sheets.",
  "notice.sheetsDownloadSteps":
    "Tệp → Tải xuống → Microsoft Excel (.xlsx), rồi mở bằng trình đọc bảng tính.",
  "notice.officeDownloadRequired":
    "File Excel này nằm trên Google Drive, trình đọc chưa mở được.",
};
