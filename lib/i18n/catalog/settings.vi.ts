import type { Translation } from "@/lib/i18n/core";
import type { settingsEn } from "@/lib/i18n/catalog/settings.en";

export const settingsVi: Translation<typeof settingsEn> = {
  "providerSettings.title": "Cài đặt",
  "providerSettings.loading": "Đang tải cài đặt…",
  "providerSettings.loadFailed": "Không tải được cài đặt.",
  "providerSettings.section": "Nhà cung cấp dịch",
  "providerSettings.intro":
    "Readlace miễn phí. Để dịch bằng AI, hãy dùng API key của riêng bạn; nhà cung cấp tính phí trực tiếp cho bạn. Không có key, Readlace dịch trên thiết bị với Chrome 138+ bản desktop.",
  "providerSettings.provider": "Nhà cung cấp",
  "providerSettings.providerOpenAI": "OpenAI",
  "providerSettings.providerMore": "Sẽ có thêm nhà cung cấp khác.",
  "providerSettings.model": "Model",
  "providerSettings.apiKey": "API key",
  "providerSettings.apiKeyPlaceholder": "sk-…",
  "providerSettings.savedKey": "Key đã lưu: {key}",
  "providerSettings.noKey": "Chưa lưu key. Đang dịch trên thiết bị.",
  "providerSettings.keyRejected":
    "OpenAI từ chối key đã lưu. Readlace dịch trên thiết bị cho đến khi bạn thay key.",
  "providerSettings.save": "Lưu",
  "providerSettings.saving": "Đang lưu…",
  "providerSettings.test": "Kiểm tra key",
  "providerSettings.testing": "Đang kiểm tra…",
  "providerSettings.remove": "Xóa key",
  "providerSettings.saved": "Đã lưu.",
  "providerSettings.removed": "Đã xóa key.",
  "providerSettings.error.invalid-key":
    "Chuỗi này không giống API key. Hãy dán toàn bộ key.",
  "providerSettings.error.invalid-model": "Hãy chọn một model trong danh sách.",
  "providerSettings.error.storage-failed": "Không lưu được cài đặt.",
  "providerSettings.error.forbidden": "Trang này không được đổi cài đặt.",
  "providerSettings.error.no-key": "Hãy dán key hoặc lưu key trước.",
  "providerSettings.test.valid": "Key dùng được với model này.",
  "providerSettings.test.invalid-key": "OpenAI từ chối key này.",
  "providerSettings.test.model-unavailable":
    "Key này không dùng được model đã chọn.",
  "providerSettings.test.rate-limited":
    "OpenAI đang giới hạn request của key này. Hãy kiểm tra hạn mức và thanh toán rồi thử lại.",
  "providerSettings.test.unreachable":
    "Không kết nối được OpenAI. Hãy thử lại sau.",
  "providerSettings.diagnostics": "Sao chép thông tin chẩn đoán",
  "providerSettings.diagnosticsHint":
    "Dùng khi báo lỗi: chỉ gồm phiên bản, cài đặt và số liệu, không có key hay nội dung trang.",
  "providerSettings.diagnosticsCopied":
    "Đã sao chép. Hãy dán vào issue trên GitHub.",
  "providerSettings.diagnosticsFailed":
    "Không sao chép được thông tin chẩn đoán.",
  "providerSettings.storageNote":
    "Key được lưu không mã hóa trong hồ sơ trình duyệt trên máy này, không đồng bộ, và chỉ gửi tới OpenAI. Hãy tạo một project key riêng cho Readlace và đặt giới hạn chi tiêu.",
  "providerSettings.privacyNote":
    "Khi có key, văn bản bạn dịch đi thẳng từ trình duyệt tới OpenAI. Readlace không có server và không thu thập dữ liệu.",
};
