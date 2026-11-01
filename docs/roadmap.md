# Roadmap — Translate Extension

## Product direction

Xây dựng extension dịch web liên tục: dịch page hiện tại, theo dõi nội dung xuất hiện sau đó, ghi nhớ lựa chọn theo website và tự động dịch lại sau navigation hoặc reload.

## Phase 1 — Demo/MVP (ưu tiên: thứ Ba tuần sau)

**Mục tiêu:** chứng minh end-to-end flow và các rủi ro cốt lõi về state, chất lượng dịch và layout.

### Scope

- Popup chọn target language EN/VI/JA.
- Auto-detect source language.
- **Translate** page hiện tại bằng Google provider theo research.
- Giữ nội dung gốc để hỗ trợ **Show original** và đổi target language.
- Dịch text DOM, menu, tab, modal và nội dung động.
- Theo dõi navigation và reload.
- Lưu Always-translate preference theo hostname.
- Lưu target language theo website.
- Có nút Clear translation cache độc lập với preference.
- Không yêu cầu user chọn **Translate** lại khi preference còn hiệu lực.
- Layout integrity: không overflow, clipping, che khuất hoặc phá cấu trúc chính.
- Ellipsis có tooltip chứa full bản dịch khi cần.
- API failure không chặn page; giữ nội dung gốc và cho phép retry.
- Review ba loại sample: text tĩnh; nội dung động/menu/modal; layout dày hoặc text dài.

### Definition of Done

- Demo được toàn bộ flow trong `docs/user-story.md` trên Chrome/Chromium.
- Có bằng chứng review translation quality và layout integrity trên ba sample.
- Đổi EN/VI/JA dịch lại từ nội dung gốc.
- Navigation và reload khôi phục đúng translation state.
- **Show original** hiển thị lại nội dung gốc mà không xóa preference.
- Provider credential không nằm trong repository; build/demo chỉ dùng môi trường internal được kiểm soát.

## Phase 2 — Quality & stability

**Mục tiêu:** làm kết quả ổn định hơn trước khi mở rộng người dùng.

- Cải thiện meaning, terminology và readability qua bộ sample lớn hơn.
- Tối ưu nhận diện nội dung DOM thay đổi và tránh dịch lặp.
- Tăng khả năng reuse bản dịch khi nội dung gốc không đổi.
- Retry có kiểm soát, trạng thái lỗi rõ ràng và xử lý rate limit.
- Bổ sung test matrix cho navigation, modal, reload, text dài và lỗi API.
- Theo dõi các lỗi layout phổ biến theo loại element/page.

## Phase 3 — Production hardening

**Mục tiêu:** loại bỏ các giới hạn bảo mật của MVP internal.

- Thay provider endpoint trực tiếp bằng backend/proxy hoặc secret management phù hợp.
- Xác định chính sách dữ liệu được phép gửi tới Google provider.
- Bổ sung cảnh báo và cơ chế bảo vệ sensitive content.
- Thêm observability cho latency, lỗi, retry, chi phí và tỷ lệ dịch thất bại.
- Xác định rate limit, quota và cơ chế kiểm soát chi phí.
- Mở rộng kiểm thử browser và website compatibility.

## Phase 4 — Expansion

**Mục tiêu:** mở rộng khả năng tiếp cận và phạm vi sử dụng sau khi MVP ổn định.

- Thêm target language ngoài EN/VI/JA.
- Accessibility cho tooltip và các thao tác chính, bao gồm keyboard focus.
- Hỗ trợ sâu hơn cho website có DOM phức tạp.
- Đánh giá riêng nhu cầu dịch text trong ảnh hoặc các loại nội dung hiện chưa thuộc MVP.
- Cân nhắc thêm browser target ngoài Chrome/Chromium.

## Dependencies và điều kiện đầu vào

- Có Google provider và cấu hình credential cho môi trường internal/demo.
- Có ba sample page đại diện cho quality review.
- Có cơ chế giữ nội dung gốc và translation state.
- Có cách nhận diện page/navigation và nội dung DOM mới.
- Glossary domain được chuẩn hóa trong [`CONTEXT.md`](../CONTEXT.md).

## Technical debt được chấp nhận trong MVP

- API key cố định chỉ dùng internal/demo.
- Chưa có backend/proxy và privacy controls production.
- Chưa tự động phát hiện sensitive content.
- Website compatibility và translation quality chỉ bảo đảm theo nguyên tắc best-effort.

## Thứ tự ưu tiên

1. Translation flow và target language.
2. Translation state qua nội dung động, navigation và reload.
3. Layout integrity và tooltip.
4. Quality review trên sample.
5. Error handling.
6. Production security, observability và mở rộng ngôn ngữ.
