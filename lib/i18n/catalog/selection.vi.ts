import type { Translation } from "@/lib/i18n/core";
import type { selectionEn } from "@/lib/i18n/catalog/selection.en";

export const selectionVi: Translation<typeof selectionEn> = {
  "selection.open": "Dịch đoạn đã chọn",
  "selection.close": "Đóng khung dịch đoạn chọn",
  "selection.translateTo": "Dịch sang",
  "selection.translate": "Dịch",
  "selection.translating": "Đang dịch…",
  "selection.timeout":
    "Bản dịch đang lâu hơn bình thường. Hãy chờ dịch xong rồi mới thử lại.",
  "selection.result": "Kết quả",
  "selection.resultLabel": "Kết quả dịch",
  "selection.copy": "Sao chép",
  "selection.copyTranslation": "Sao chép bản dịch",
  "selection.copied": "Đã sao chép",
  "selection.copyFailed": "Không sao chép được",
  "selection.error.authRequired":
    "Hãy đăng nhập từ popup Readlace trên thanh công cụ rồi thử lại.",
  "selection.error.tooLong": "Đoạn đã chọn quá dài để dịch.",
  "selection.error.invalid": "Không thể dịch đoạn đã chọn này.",
  "selection.error.failed": "Dịch không thành công. Hãy thử lại.",
};
