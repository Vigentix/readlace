import type { Translation } from "@/lib/i18n/core";
import type { readerEn } from "@/lib/i18n/catalog/reader.en";

export const readerVi: Translation<typeof readerEn> = {
  "reader.brandSubtitle": "Trình đọc bảng tính",
  "reader.localSubtitle": "Trình đọc bảng tính",
  "reader.driveSubtitle": "Trình đọc bảng tính Google Drive",

  "reader.controls": "Điều khiển trình đọc bảng tính",
  "reader.worksheet": "Trang tính",
  "reader.worksheetPlaceholder": "Chọn trang tính",
  "reader.translateTo": "Dịch sang",
  "reader.loading": "Đang tải…",
  "reader.primary.translate": "Dịch",
  "reader.primary.translating": "Đang dịch…",
  "reader.primary.translationOn": "Đang bật dịch",
  "reader.primary.resume": "Dịch tiếp",
  "reader.primary.retryUnresolved": "Dịch lại phần còn thiếu",
  "reader.primary.retry": "Thử lại",
  "reader.stop": "Dừng",
  "reader.presentation": "Cách hiển thị ô",
  "reader.presentation.translation": "Bản dịch",
  "reader.presentation.original": "Bản gốc",
  "reader.refresh": "Làm mới",
  "reader.clearView": "Xóa kết quả hiển thị",
  "reader.disconnecting": "Đang ngắt kết nối…",
  "reader.disconnectGoogle": "Ngắt kết nối Google",

  "reader.sourceState": "Nguồn bảng tính",
  "reader.phase.bootstrapping": "Đang chuẩn bị trình đọc…",
  "reader.phase.identifying": "Đang nhận diện bảng tính…",
  "reader.phase.discovering": "Đang dò trang tính…",
  "reader.phase.loadingSheet": "Đang tải trang tính…",
  "reader.phase.awaitingStart": "Sẵn sàng đọc bảng tính này",
  "reader.phase.empty": "Trang tính này không có văn bản để đọc",
  "reader.phase.error": "Trình đọc không tải được bảng tính này",
  "reader.phase.disconnecting": "Đang ngắt kết nối Google…",

  "reader.grid.sheet": "Trang tính {title}",
  "reader.grid.rowNumbers": "Số dòng",
  "reader.grid.hiddenColumn": "Cột {column} bị ẩn",
  "reader.grid.blank": "Trống",
  "reader.cell.details": "Chi tiết ô đang chọn",
  "reader.cell.source": "Bản gốc",
  "reader.cell.displayed": "Kết quả hiển thị",
  "reader.cell.translation": "Bản dịch",
  "reader.cell.notTranslated": "Chưa dịch",

  "reader.badge.drive": "Drive · chỉ đọc",
  "reader.badge.local": "File ở lại trên máy",
  "reader.source.driveFile": "File Google Drive",
  "reader.source.localFile": "File trên máy",
  "reader.source.driveWorkbook": "Bảng tính Drive",
  "reader.source.localWorkbook": "Bảng tính trên máy",
  "reader.worksheetAfterTranslate": "Bấm Dịch để tải trang tính",
  "reader.results.drive": "Bảng tính Google Drive",
  "reader.results.local": "Bảng tính trên máy",
  "reader.recovery": "Khôi phục kết nối trình đọc",
  "reader.openInTab": "Mở trình đọc trong thẻ mới",
  "reader.reconnectWorkspace": "Kết nối lại Google Workspace",
  "reader.local.selection": "Chọn file trên máy",
  "reader.local.openInput": "Mở file bảng tính",
  "reader.local.reading": "Đang đọc bảng tính…",
  "reader.local.choose": "Chọn hoặc thả file bảng tính",
  "reader.local.hint": ".csv, .xlsx hoặc .xlsm · tối đa 20 MiB",
  "reader.local.boundaries":
    "Dữ liệu file ở lại trên máy này và không bao giờ được tải lên. Sau khi bạn bấm Dịch, chỉ văn bản trong các ô đang hiển thị được gửi đến Readlace để dịch. Trình đọc chỉ đọc, không bao giờ chạy macro và hỗ trợ tối đa 50 trang tính, 100.000 dòng, 16.384 cột, 10.000 ô có dữ liệu và 256.000 ký tự mỗi trang tính. Không hỗ trợ biểu đồ, hình ảnh, pivot và hiển thị chính xác như Excel.",
  "reader.drop.title": "Thả để mở bảng tính này trên máy",
  "reader.drop.hint":
    ".csv, .xlsx hoặc .xlsm · tối đa 20 MiB · không bao giờ tải lên",
  "reader.drop.multiple": "Mỗi lần chỉ thả một file bảng tính.",
  "reader.desc.awaitingStart": "Bấm Dịch để tìm và dịch bảng tính hiện tại.",
  "reader.desc.refreshRetry": "Bấm Làm mới để thử lại.",
  "reader.desc.driveSaved":
    "Trình đọc đọc bản bảng tính đã lưu gần nhất. Các thay đổi chưa lưu có thể chưa có ở đây.",
  "reader.desc.local":
    "Đang đọc file này trên máy. Dữ liệu file ở lại trên máy này.",

  "reader.status.chooseFile": "Chọn một file bảng tính để bắt đầu.",
  "reader.status.discoveringDrive": "Đang tìm bảng tính đã lưu trên Drive…",
  "reader.status.loadedDrive": "Đã tải {sheet} từ Google Drive.",
  "reader.status.loadedLocal": "Đã tải {sheet} trên máy.",
  "reader.status.readingFile": "Đang đọc {name} trên máy…",
  "reader.status.translatingCells": {
    other: "Đang dịch {count} ô đang hiển thị…",
  },
  "reader.status.slow":
    "Bản dịch đang mất hơn 30 giây. Đang chờ yêu cầu nền hoàn tất.",
  "reader.status.completed": { other: "Đã hoàn tất {count} bản dịch." },
  "reader.status.queued": "Bản dịch đang chờ yêu cầu trước hoàn tất.",
  "reader.status.driveCleared":
    "Đã xóa bảng tính Drive khỏi trình đọc. Hãy làm mới để tải lại.",
  "reader.status.localCleared": "Đã xóa nội dung trình đọc.",
  "reader.status.sourceChanged":
    "Thẻ nguồn đã thay đổi. Đang tải lại trình đọc…",
  "reader.status.disconnecting": "Đang ngắt kết nối Google Workspace…",
  "reader.status.settingsChanged":
    "Đã đổi cài đặt dịch. Kết quả trước đó đã được xóa.",

  "reader.partial.unresolved": { other: "Không dịch được {count} ô." },
  "reader.partial.oversized": {
    other: "{count} ô vượt giới hạn dịch 4.000 ký tự.",
  },
  "reader.partial.mixed": {
    other:
      "Có thể dịch lại {count} ô; {oversized} ô vượt giới hạn dịch 4.000 ký tự.",
  },

  "reader.error.authRequired":
    "Hãy đăng nhập tài khoản Readlace trong popup tiện ích.",
  "reader.error.authUnavailable":
    "Tạm thời chưa xác minh được tài khoản Readlace.",
  "reader.error.sessionChanged":
    "Phiên đăng nhập Readlace vừa thay đổi. Hãy mở lại trình đọc để tiếp tục.",
  "reader.error.invalidTranslation":
    "Trình đọc nhận được phản hồi bản dịch không hợp lệ.",
  "reader.error.translateFailed": "Trình đọc không dịch được các ô này.",
  "reader.error.staleTranslation":
    "Trình đọc đã bỏ qua một phản hồi bản dịch đã cũ.",
  "reader.error.disconnectFailed":
    "Không ngắt kết nối được Google Workspace. Hãy thử lại.",
  "reader.error.openTabFailed":
    "Trình đọc không mở được thẻ. Hãy làm mới hoặc thử mở lại thẻ trình đọc.",
  "reader.error.readFailed": "Trình đọc không đọc được file này.",
  "reader.error.sheetTimeout": "Tải trang tính mất hơn 15 giây nên đã dừng.",
  "reader.error.parseTimeout": "Phân tích file mất hơn 15 giây nên đã dừng.",

  "reader.local.unsupportedFileType": "Hãy chọn file .csv, .xlsx hoặc .xlsm.",
  "reader.local.fileTooLarge":
    "File này vượt giới hạn 20 MiB của trình đọc bảng tính.",
  "reader.local.tooManySheets": "Bảng tính này vượt giới hạn 50 trang tính.",
  "reader.local.dimensionsTooLarge":
    "Trang tính này vượt giới hạn 100.000 dòng hoặc 16.384 cột.",
  "reader.local.contentTooLarge":
    "Trang tính này vượt giới hạn 10.000 ô hoặc 256.000 ký tự.",
  "reader.local.encryptedWorkbook":
    "Chưa hỗ trợ bảng tính được mã hóa hoặc đặt mật khẩu.",
  "reader.local.invalidWorkbook":
    "Trình đọc không phân tích được bảng tính này.",
  "reader.local.invalidRequest":
    "Trình đọc nhận được phản hồi bảng tính không hợp lệ.",

  "reader.drive.invalidRequest":
    "Trình đọc nhận được yêu cầu tải xuống Drive không hợp lệ.",
  "reader.drive.googleAuthRequired":
    "Hãy kết nối lại Google Workspace để cấp quyền chỉ đọc Drive.",
  "reader.drive.accessDenied":
    "Google đã từ chối truy cập. Hãy kiểm tra quyền đã cấp, chính sách của quản trị viên và quyền truy cập file.",
  "reader.drive.oauthExpired":
    "Quyền truy cập Google Workspace đã hết hạn. Hãy kết nối lại để tiếp tục.",
  "reader.drive.unsupportedFileType":
    "File Drive đang mở không phải bảng tính .xlsx hoặc .xlsm.",
  "reader.drive.downloadNotAllowed":
    "Chủ sở hữu hoặc tổ chức không cho phép tải file này xuống.",
  "reader.drive.officeDownloadRequired":
    "File Excel này nằm trên Google Drive, trình đọc chưa mở được. Tệp → Tải xuống → Microsoft Excel (.xlsx), rồi mở bằng trình đọc bảng tính.",
  "reader.drive.fileTooLarge":
    "File này vượt giới hạn 20 MiB của trình đọc Drive.",
  "reader.drive.downloadTimeout":
    "Tải xuống từ Google Drive mất hơn 30 giây. Hãy làm mới để thử lại.",
  "reader.drive.temporarilyUnavailable":
    "Google Drive tạm thời không khả dụng. Hãy làm mới để thử lại.",
  "reader.drive.channelUnavailable":
    "Trình đọc không kết nối được với tiện ích. Hãy làm mới để thử lại.",
  "reader.drive.sourceTabChanged":
    "Thẻ nguồn đã thay đổi. Hãy quay lại file Office đang mở rồi mở lại trình đọc.",
  "reader.drive.invalidResponse":
    "Trình đọc nhận được phản hồi tải xuống Drive không hợp lệ.",
};
