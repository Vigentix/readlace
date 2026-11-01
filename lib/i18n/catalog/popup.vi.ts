import type { Translation } from "@/lib/i18n/core";
import type { popupEn } from "@/lib/i18n/catalog/popup.en";

export const popupVi: Translation<typeof popupEn> = {
  loading: "Đang tải…",

  "settings.open": "Cài đặt",
  "engine.onDevice":
    "Đang dịch trên thiết bị. Thêm API key OpenAI trong Cài đặt để dịch bằng AI.",
  "engine.keyRejected":
    "OpenAI từ chối API key của bạn. Đang dịch trên thiết bị; hãy kiểm tra key trong Cài đặt.",
  "account.menu": "Menu",
  "account.clearSaved": "Xóa bản dịch đã lưu",
  "language.label": "Ngôn ngữ",

  "page.card": "Trang này",
  "page.detectedLanguage": "Ngôn ngữ trang",
  "page.translateTo": "Dịch sang",
  "page.sheetsInPlace": "Chưa dịch được Google Sheets ngay tại chỗ.",
  "page.serviceUnavailable": "Dịch vụ dịch đang không khả dụng.",
  "page.always": "Luôn dịch trang này",
  "page.statusTranslated": "Đã dịch sang {language}",
  "page.statusPartial": "Đã dịch một phần.",
  "page.translateRest": "Dịch phần còn lại",
  "page.statusOriginal": "Đang xem bản gốc",

  "unavailable.page": "Không dịch được trên trang này.",
  "unavailable.docs": "Tạm thời chưa hỗ trợ Google Docs.",
  "unavailable.readerNotConfigured":
    "Bản cài đặt này chưa cấu hình trình đọc Google Workspace.",
  "unavailable.readerBrowser":
    "Trình duyệt này chưa hỗ trợ trình đọc Google Workspace.",
  "unavailable.toolsFailed": "Không tải được công cụ dịch trên trang này.",

  "translate.button": "Dịch trang",
  "translate.translateTo": "Dịch sang {language}",
  "translate.translation": "Bản dịch",
  "translate.showTranslation": "Xem bản dịch",
  "translate.stop": "Dừng",
  "translate.stopLabel": "Dừng dịch và hiện bản gốc",
  "translate.opening": "Đang mở…",
  "translate.preparing": "Đang chuẩn bị…",
  "translate.translating": "Đang dịch…",
  "translate.retry": "Thử lại",
  "translate.view": "Hiển thị trang",
  "translate.original": "Bản gốc",
  "translate.showOriginal": "Xem bản gốc",
  "translate.checkingSession": "Đang kiểm tra phiên đăng nhập…",
  "translate.freeBlocked": "Cần API key để dịch trên trình duyệt này.",

  "native.downloading": "Đang tải gói ngôn ngữ để dịch trên máy…",
  "native.downloadingPercent":
    "Đang tải gói ngôn ngữ để dịch trên máy {percent}%",
  "native.progress": "Tải gói ngôn ngữ để dịch trên máy",

  "status.translateFailed": "Không dịch được trang này. Hãy thử lại.",
  "status.readerOpenFailed": "Không mở được trình đọc Google Workspace.",
  "status.originalRestored": "Đã trả lại bản gốc.",
  "status.translationStopped": "Đã dừng dịch, trang trở về bản gốc.",
  "status.cannotTranslate": "Không thể dịch trang này",
  "status.clearConfirm":
    "Xóa các bản dịch đã lưu? Tùy chọn cho từng trang vẫn được giữ.",
  "status.clearing": "Đang xóa bản dịch đã lưu…",
  "status.cleared": "Đã xóa bản dịch đã lưu.",
  "status.clearFailed": "Không xóa được bản dịch đã lưu.",
  "status.localReaderFailed": "Không mở được trình đọc bảng tính. Hãy thử lại.",

  "tools.section": "Công cụ bảng tính",
  "tools.open": "Mở file bảng tính",
  "tools.opening": "Đang mở file bảng tính…",
  "tools.hint": "CSV, XLSX, XLSM · file ở lại trên máy",

  "notice.onDevice": "Dịch trên máy",
  "notice.onDeviceAddKey":
    "Thêm API key OpenAI trong Cài đặt để dịch trên trình duyệt này.",
  "notice.sheets": "Google Sheets",
};
