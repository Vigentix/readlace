import type { Translation } from "@/lib/i18n/core";
import type { workspaceEn } from "@/lib/i18n/catalog/workspace.en";

export const workspaceVi: Translation<typeof workspaceEn> = {
  "workspace.subtitle": "Trình đọc Google Workspace",

  "workspace.error.notConfigured":
    "Bản dựng này chưa cấu hình Trình đọc Google Workspace.",
  "workspace.error.unsupportedBrowser":
    "Trình đọc Google Workspace không dùng được trên trình duyệt này.",
  "workspace.error.unsupportedUrl":
    "Hãy mở một Google Sheet gốc hoặc file .xlsx/.xlsm được hỗ trợ trên Drive, rồi mở lại trình đọc. Google Docs tạm thời chưa được hỗ trợ.",
  "workspace.error.unsupportedFileType":
    "Loại file này chưa được hỗ trợ. Hãy mở một Google Sheet gốc hoặc file .xlsx/.xlsm trên Drive.",
  "workspace.error.googleAuthRequired": "Kết nối Google Workspace để tiếp tục.",
  "workspace.error.googleAccessDenied":
    "Google đã từ chối quyền truy cập. Hãy kiểm tra màn hình đồng ý và quyền truy cập file.",
  "workspace.error.googleOauthConfiguration":
    "Chưa cấu hình quyền truy cập Google Workspace cho trình duyệt này.",
  "workspace.error.googleOauthResponse":
    "Google trả về phản hồi cấp quyền không hợp lệ.",
  "workspace.error.googleOauthScope":
    "Google chưa cấp quyền chỉ đọc cần thiết.",
  "workspace.error.googleOauthExpired":
    "Quyền truy cập Google Workspace đã hết hạn. Hãy kết nối lại để tiếp tục.",
  "workspace.error.googleOauthNetwork":
    "Không kết nối được mạng để cấp quyền Google.",
  "workspace.error.googleOauthFailed":
    "Cấp quyền Google Workspace không thành công.",
  "workspace.error.sheetsReaderUnavailable":
    "Sắp có tính năng đọc trực tiếp Google Sheets. Tệp → Tải xuống → Microsoft Excel (.xlsx), rồi mở bằng trình đọc bảng tính.",
  "workspace.error.officeDownloadRequired":
    "File Excel này nằm trên Google Drive, trình đọc chưa mở được. Tệp → Tải xuống → Microsoft Excel (.xlsx), rồi mở bằng trình đọc bảng tính.",
  "workspace.error.googlePermissionDenied":
    "Hãy cho phép truy cập Google khi Chrome hỏi để kết nối Google Workspace.",
  "workspace.error.sourceTabChanged":
    "Thẻ nguồn đã thay đổi. Hãy làm mới trình đọc để tiếp tục.",
  "workspace.error.responseTooLarge":
    "Phản hồi từ Google quá lớn so với giới hạn của trình đọc.",
  "workspace.error.contentTooLarge":
    "File này vượt quá giới hạn nội dung của trình đọc.",
  "workspace.error.rateLimited":
    "Google đang giới hạn tần suất yêu cầu. Hãy thử lại sau.",
  "workspace.error.temporarilyUnavailable":
    "Google Workspace tạm thời không khả dụng.",
  "workspace.error.readerChannelUnavailable":
    "Trình đọc không xác minh được nguồn của bảng bên này. Hãy mở trình đọc trong một thẻ để tiếp tục.",
  "workspace.error.invalidRequest":
    "Trình đọc nhận được phản hồi không hợp lệ. Hãy làm mới và thử lại.",
  "workspace.error.authRequired":
    "Hãy đăng nhập tài khoản Readlace trong popup tiện ích.",
  "workspace.error.authUnavailable":
    "Tạm thời không xác minh được tài khoản Readlace.",
  "workspace.error.openTabFailed":
    "Không mở được trình đọc trong thẻ mới. Hãy thử lại.",

  "workspace.status.loadingReader": "Đang tải trình đọc…",
  "workspace.status.discoveringColumns": "Đang dò cột {scanned}/{total}…",
  "workspace.status.discoveringRows": "Đang dò dòng {scanned}/{total}…",
  "workspace.status.loadingNextRows": "Đang tải 100 dòng tiếp theo…",
  "workspace.status.loadingSource": "Đang tải nguồn…",
  "workspace.status.recordsLoaded": { other: "Đã tải {count} mục." },
  "workspace.status.discoveryPaused": "Đã tạm dừng dò tìm.",
  "workspace.status.discoveryStopped": "Đã dừng dò tìm.",
  "workspace.status.discoveryComplete": "Đã dò xong các cột.",
  "workspace.status.connected": "Đã kết nối Google Workspace.",
  "workspace.status.connectToLoad": "Kết nối Google Workspace để tải file này.",
  "workspace.status.reconnecting": "Đang kết nối lại trình đọc…",
  "workspace.status.loadingActiveSource": "Đang tải nguồn hiện tại…",
  "workspace.status.waitingAuthorization": "Đang chờ Google cấp quyền…",
  "workspace.status.disconnecting": "Đang ngắt kết nối Google Workspace…",
  "workspace.status.disconnected": "Đã ngắt kết nối Google Workspace.",
  "workspace.status.partial":
    "Đã dịch {translated}; {unresolved} mục chưa dịch được.",
  "workspace.status.translationsCompleted": {
    other: "Đã dịch xong {count} mục.",
  },
  "workspace.status.noUntranslatedVisible":
    "Không có văn bản chưa dịch nào đang hiển thị.",
  "workspace.status.selectedTooLarge":
    "Nội dung đã chọn vượt quá giới hạn dịch của mỗi mục.",
  "workspace.status.noUntranslatedAvailable":
    "Không còn văn bản nào chưa dịch.",
  "workspace.status.translating": "Đang dịch…",
  "workspace.status.translationsKept": {
    other: "Đã giữ {count} bản dịch trước khi yêu cầu dừng.",
  },
  "workspace.status.viewCleared":
    "Đã xóa kết quả hiển thị. Nội dung nguồn và bản dịch đã lưu không thay đổi.",
  "workspace.status.settingsChanged":
    "Cài đặt dịch đã thay đổi. Kết quả trước đó trong trình đọc đã được xóa.",
  "workspace.status.loadingWorksheet": "Đang tải trang tính…",

  "workspace.connection.connected": "Đã kết nối",
  "workspace.connection.notConnected": "Chưa kết nối",
  "workspace.connection.unavailable": "Không có quyền truy cập",
  "workspace.connection.checking": "Đang kiểm tra quyền truy cập",

  "workspace.openingReader": "Đang mở trình đọc…",
  "workspace.openInTab": "Mở trình đọc trong thẻ mới",
  "workspace.activeSheet": "Trang tính hiện tại",
  "workspace.documentTab": "Thẻ tài liệu",
  "workspace.notLoaded": "Chưa tải",
  "workspace.untitledTab": "Thẻ chưa đặt tên",
  "workspace.worksheetUnavailable":
    "Không lấy được tên trang tính. Hãy làm mới để thử lại.",
  "workspace.continueDiscovery": "Tiếp tục dò tìm",
  "workspace.controls": "Điều khiển trình đọc",
  "workspace.translateTo": "Dịch sang",
  "workspace.translate": "Dịch",
  "workspace.translateLoaded": "Dịch phần đã tải",
  "workspace.translateSelected": "Dịch mục đã chọn ({count})",
  "workspace.cellPresentation": "Cách hiển thị ô",
  "workspace.presentation.translation": "Bản dịch",
  "workspace.presentation.original": "Bản gốc",
  "workspace.refresh": "Làm mới",
  "workspace.clearView": "Xóa kết quả hiển thị",
  "workspace.disconnect": "Ngắt kết nối",
  "workspace.connect": "Kết nối Google Workspace",
  "workspace.reconnect": "Kết nối lại Google Workspace",
  "workspace.openLocalSpreadsheet": "Mở file bảng tính",

  "workspace.results.sheet": "Bảng tính trong trình đọc",
  "workspace.results.records": "Các mục trong trình đọc",
  "workspace.record.select": "Chọn {anchor}",
  "workspace.record.formula": "Công thức",
  "workspace.record.error": "Lỗi",
  "workspace.record.nonText": "Không phải văn bản",
  "workspace.record.tooLarge": "Quá lớn",
  "workspace.record.translationFailed": "Dịch thất bại",
  "workspace.record.unresolved": "Chưa dịch được",
  "workspace.record.source": "Bản gốc",
  "workspace.record.displayedValue": "Giá trị hiển thị: {value}",
  "workspace.record.translation": "Bản dịch",
  "workspace.empty.readyToRead": "Sẵn sàng đọc bảng tính này",
  "workspace.empty.connectToRead": "Kết nối Google Workspace để đọc file này.",
  "workspace.empty.clickTranslate": "Bấm Dịch để dò tìm và dịch file này.",

  "shell.documentTitle": "Readlace – Trình đọc",
  "shell.loadingSource": "Đang tải nguồn",
  "shell.notLoaded": "Chưa tải",
  "shell.cannotVerifySource":
    "Trình đọc không xác minh được nguồn của bảng bên này. Hãy mở trình đọc trong một thẻ để tiếp tục.",
  "shell.openSupportedSpreadsheet":
    "Hãy mở một bảng tính được hỗ trợ rồi bấm biểu tượng tiện ích để tiếp tục.",
  "shell.openTabFailed": "Không mở được trình đọc trong thẻ mới. Hãy thử lại.",
  "shell.openingReader": "Đang mở trình đọc…",
  "shell.openInTab": "Mở trình đọc trong thẻ mới",
};
