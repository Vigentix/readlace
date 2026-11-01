# User stories — Translate Extension

## Current scope correction — 2026-10-03

Page translation bypasses authored `translate="no"`, `.notranslate` and browser translation opt-out metadata for readable text/attributes/title. Editable values and editor/code/math content remain protected. Google Docs is temporarily unsupported and must display an unavailable state rather than a Reader translation action; Docs-specific acceptance criteria below are inactive until support is restored.

## 1. Mục tiêu sản phẩm

Cung cấp một lớp dịch liên tục trên web: người dùng chọn ngôn ngữ đích, dịch page hiện tại, sau đó tiếp tục nhận bản dịch khi điều hướng, mở nội dung động hoặc reload mà không phải chọn **Translate** lại.

## 2. Người dùng và thuật ngữ

- Người dùng chính: người dùng cuối trên Chrome/Chromium.
- Ngôn ngữ nguồn: tự động nhận diện.
- Ngôn ngữ đích: English (EN), Vietnamese (VI) hoặc Japanese (JA).
- Thuật ngữ chuẩn: [`CONTEXT.md`](../CONTEXT.md).
- Nhãn hành động/trạng thái: **Translate**, **Translating…**, **Preparing…**, disabled **Translated**, và **Show original**; không dùng “on/off” hoặc “start/stop translation”.

## 3. User stories và acceptance criteria

### US-01 — Dịch page theo ngôn ngữ đích

**Là** người dùng đang đọc một page, **tôi muốn** chọn EN, VI hoặc JA và chọn **Translate**, **để** đọc nội dung bằng ngôn ngữ mong muốn.

**Acceptance criteria**

- User chọn được EN, VI hoặc JA.
- Page language được auto-detect để hiển thị evidence; explicit **Translate** luôn override detection.
- Khi chọn **Translate**, text hiển thị đủ điều kiện trong page được dịch từ nội dung gốc.
- Mỗi provider result thành công chỉ được xem là hoàn tất sau khi bản dịch vẫn còn trong DOM; layout handling không được đổi nó về source text.
- **Translate** chỉ bị disable khi signed out, đang busy, hoặc target đã được apply hoàn tất; detection trùng target không chặn manual action.
- Nội dung gốc được giữ lại để có thể chọn **Show original** hoặc đổi ngôn ngữ đích.
- Provider source được resolve theo từng record: Japanese script → `ja`, compatible trusted Page language hint → hint, còn lại → `auto`; cùng route được dùng cho provider, validation, native recovery và Saved translations identity.
- Mỗi accepted result được lưu độc lập theo normalized record, provider/model hoặc recovery chain, route và target. Trong OpenAI-selected run, valid OpenAI v10 cache thắng chain v1; valid chain hit thắng provider dispatch. Chain key là chính xác `translationCache:chain:v1:openai-google-native:<route>:<target>:<sha1(normalized-source)>`, value chứa accepted text và provenance chính xác `google | browser-native`, được local-revalidate và chỉ ghi sau retained DOM acceptance. Chain cache không ghi vào hoặc giả danh OpenAI/Google namespace; Google-selected run không đọc chain cache. Cache hit, deterministic value và duplicate owner không tiêu tốn provider record/character budget; sibling failure không chặn accepted record khác được lưu.
- Provider cloud stage gọi fixed authenticated backend bằng `OPENAI_API_KEY` và `GOOGLE_TRANSLATION_API_KEY` thuộc backend; provider key không được accept từ, lưu, return hoặc build trong extension. Trong OpenAI-selected run, mỗi eligible connected record theo đúng thứ tự: cache hợp lệ → tối đa ba OpenAI attempts → một Google attempt → một browser-native attempt với route `ja|en|vi` đã resolve và khác target → unresolved. Ba OpenAI attempts giữ retry set hiện tại: empty, source-identical, network/timeout, 408, 429 và 5xx sau 500 ms, 1.500 ms hoặc bounded `Retry-After`; accepted, permanent/configuration, oversized, stale/detached và cache/storage outcome không được gửi lại. Stage chạy tuần tự; accepted record không vào stage sau, không tiêu tốn budget sau và không được resend trong cùng generation. Google fallback fail không retry và rơi xuống native. `auto` và same-target skip native; unavailable, stalled, rejected, stale hoặc detached vẫn unresolved. Ceiling chính xác là `3 OpenAI + 1 Google + 1 browser-native`, với native watchdog tối đa 30 giây. Google-selected run vẫn là Google → native và không tham gia OpenAI chain cache. Mixed accepted/unresolved chỉ kết thúc `partial` sau khi bounded chain hoàn tất.
- Same-target `partial` vẫn hiển thị **Translate**; click này tạo một bounded generation mới chỉ cho discovered active unresolved records, reset budget `3 + 1 + 1` của OpenAI-selected record mà không restore hoặc request lại accepted records. Đổi target vẫn full restore từ original trước khi dịch.
- Chỉ account được team tạo bằng `pnpm account:create` hoặc token-protected backend endpoint mới đăng nhập bằng email/password; CLI dùng chính endpoint này, không ghi trực tiếp database. Session rotate/restore qua browser restart. Không có public signup, OAuth, invitation, forgot-password, self-service reset, provider-key input, companion app, setup/manual language-pack action, Retry control hoặc second translation action. Trạng thái accessible có thể hiển thị auth work hoặc `preparing` trong lúc browser tự chuẩn bị language support.
- Giá trị user đang nhập trong editable `input`/`textarea` luôn byte-identical; extension không dịch hoặc mutate submitted business data.

### US-02 — Dịch nội dung xuất hiện sau đó

**Là** người dùng đã chọn **Translate**, **tôi muốn** menu, tab, modal và nội dung động được dịch, **để** trải nghiệm không bị ngắt quãng.

**Acceptance criteria**

- Text mới xuất hiện hoặc thay đổi được nhận diện là nội dung cần dịch.
- Lazy eligibility chỉ gồm viewport hiện tại cùng một viewport phía trên/dưới. Nội dung ban đầu, nội dung vừa scroll tới và nội dung động mới eligible tiếp tục được dịch tự động mà không chờ một request cũ hoàn tất.
- Khi provider chỉ lỗi một phần, các result thành công được giữ lại và chỉ unresolved retryable records được tự gửi lại; OpenAI-selected run chỉ chuyển residual sang một Google attempt rồi một native attempt sau khi ba OpenAI attempts đã exhausted. Run chỉ kết thúc `partial` sau khi bounded chain khả dụng đã hoàn tất.
- Disabled **Translated** chỉ có nghĩa mọi discovered eligible record đã hoàn tất cho selected target; offscreen undiscovered records không làm state thành `partial`. Scroll tới record mới có thể tạm hiển thị **Translating…**; scroll-back không resend accepted records.
- User không phải mở extension và chọn **Translate** thủ công cho từng nội dung mới.

### US-03 — Luôn dịch một website

**Là** người dùng thường xuyên đọc một website, **tôi muốn** ghi nhớ lựa chọn dịch cho website đó, **để** những lần truy cập sau được dịch tự động.

**Acceptance criteria**

- Preference được lưu theo registrable domain (eTLD+1); các hostname cùng eTLD+1 chia sẻ preference (sibling hosts, không theo exact hostname).
- Target language được lưu theo từng website.
- Khi truy cập hoặc reload page thuộc website (cùng eTLD+1) đã ghi nhớ, extension tự động áp dụng **Translate**.
- Always-translate không auto-run khi `tabs.detectLanguage` và root `html[lang]` cùng resolve thành preference target; conflict, missing, invalid hoặc `und` vẫn auto-run.
- Việc auto-translate không yêu cầu user mở popup và chọn lại **Translate**.
- Explicit **Translate** luôn override Page language evidence kể cả khi Always-translate đã auto-skip.

### US-04 — Xem lại nội dung gốc

**Là** người dùng đang xem bản dịch, **tôi muốn** chọn **Show original**, **để** đối chiếu với nội dung gốc.

**Acceptance criteria**

- Nội dung hiện tại được khôi phục về text gốc.
- Target language không bị thay đổi.
- Preference **Always-translate** không bị xóa.
- Việc chọn **Show original** không tự động dịch lại ngay nội dung hiện tại.

### US-05 — Duy trì translation state

**Là** người dùng đã cấu hình dịch, **tôi muốn** translation state được duy trì qua navigation và reload, **để** không phải kích hoạt lại extension.

**Acceptance criteria**

- Target language và preference theo website được khôi phục sau reload.
- Page mới trong cùng website (cùng eTLD+1) được tự động dịch nếu preference còn hiệu lực.
- Bản dịch không bị tạo lại không cần thiết khi nội dung gốc không đổi.
- Accepted Saved translations được bulk-read, revalidate và fan out cho duplicate DOM owners; page URL, DOM piece boundary, record order và run ID không là cache identity. Warm OpenAI-chain hit giữ provenance Google/native và tái sử dụng zero-call cho đến khi **Clear saved translations**.
- Khi target language đổi, bản dịch mới được tạo từ nội dung gốc, không dịch từ bản dịch cũ.

### US-06 — Giữ layout dễ đọc

**Là** người dùng đọc page đã dịch, **tôi muốn** nội dung không làm hỏng layout, **để** vẫn sử dụng được page.

**Acceptance criteria**

- Provider result thành công luôn còn là bản dịch; layout fallback không được khôi phục source text.
- Flow content và trường hợp mơ hồ dùng raw translation và natural wrap. Bounded single-line content hiển thị full text khi vừa remaining owner capacity, nếu overflow thật thì ellipsis; bounded multi-line content giữ visible footprint bằng clamp.
- Dedicated remaining capacity là khoảng nội dung của owner sau padding, border, icon, gap và occupied chrome; không dùng source glyph width khi đã có dedicated owner lớn hơn.
- Shared inline/nav rows không có dedicated owner giữ source-capacity-only và không mượn sibling hoặc row-wide width. Layout repair chỉ tác động ownership group hiện tại, không làm record khác thất bại.
- Captured single-line shrink-to-fit control giữ original used footprint; bản dịch vượt inner interval phải ellipsis trong footprint đó và không được làm host, action group, hoặc header nở ra.
- Khi text bị truncate, hover `title` chứa đúng full bản dịch; khi text fit thì không có truncation hoặc `title`.
- Protected item/row/owner geometry không đổi quá `1 CSS px`; trường hợp wrapper không hỗ trợ vẫn giữ raw translation theo best-effort policy.
- Layout integrity được xác nhận bằng deterministic fixtures và các live smoke Asahi, Wikipedia, Yahoo có evidence theo từng record.

### US-07 — Đánh giá translation quality

**Là** reviewer nội bộ, **tôi muốn** đánh giá bản dịch trên sample đại diện, **để** xác nhận MVP giữ được meaning, terminology và readability.

**Acceptance criteria**

- Có ít nhất ba sample: text tĩnh; nội dung động/menu/modal; layout dày hoặc text dài.
- Reviewer đánh giá translation quality và layout integrity trên cả ba sample.
- Kết quả review được ghi nhận trước demo.

### US-08 — Đọc bản dịch của Google Sheets và Google Docs

**Là** người dùng đang làm việc trong native Google Sheet hoặc Google Doc, **tôi muốn** đọc bản dịch trong Readlace Reader, **để** hiểu nội dung mà không thay đổi file, formula, format, selection hoặc undo history của Google editor.

**Acceptance criteria**

- Trên exact native Google Sheets/Docs editor route, popup **Translate** mở `/reader.html` trong window-scoped Chromium side panel; nếu side panel unavailable/reject thì mở cùng page trong extension tab. Cùng một Chromium package chạy trên desktop Chrome, Comet và Edge. Browser cho phép user resize Side Panel và Reader fill width hiện có; extension không set hoặc claim panel width. Không overlay hoặc mutate Google editor.
- User vẫn phải đăng nhập Readlace bằng managed email/password. **Connect Google Workspace** là read-only resource authorization riêng, không tạo/exchange/store/refresh Readlace session.
- Google OAuth dùng chính xác `spreadsheets.readonly` (ADR 0015 bỏ `documents.readonly` và restricted `drive.readonly`); `identity` và Google API host là optional permissions, chỉ xin khi bấm **Connect Google Workspace**. Native Sheets Reader nằm sau remote flag `workspaceSheetsReader` (mặc định tắt): khi tắt, Sheet hiển thị thông báo "coming soon — File → Download → .xlsx rồi mở trong Local Reader" kèm **Open local spreadsheet**; Drive Office workbook cũng hiển thị hướng dẫn tải xuống. Một Web application client trong `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID` phục vụ package dùng chung qua `identity.launchWebAuthFlow`; redirect được derive bằng `identity.getRedirectURL("google-workspace")` và phải là `https://imlhpiikjakgljngkdalbfgdpkniejdb.chromiumapp.org/google-workspace` với fixed extension ID. Build cũ chỉ có hai scope phải bị invalid và user reconnect/re-consent rõ ràng; không có browser sniffing/native fallback, client secret hoặc Google API key.
- Token là versioned record chỉ trong trusted `storage.session`, bound với client/extension/scopes/expiry/managed account và được restore sau service-worker restart trong cùng browser session. Token không vào local/sync/IndexedDB, log, runtime message, page, backend hoặc provider payload. Invalid/expired token, Google `401`, Disconnect, managed logout/account change hoặc configuration change phải clear token; browser/extension lifecycle clear session storage, nên browser restart hoặc expiry có thể yêu cầu reconnect.
- Google Workspace Reader hỗ trợ native Google Sheets/Docs và latest saved snapshot của Drive-hosted `.xlsx`/`.xlsm` đang mở trong Google Sheets Office mode. Native Sheets `GRID` dùng progressive grid; Docs giữ record cards. Khi native Sheets discovery trả Office `400`, Reader tự chuyển cùng panel sang Drive Office mode, không hiện local picker; background re-derive file ID từ source tab và chỉ dùng fixed Drive metadata/media GET. Picker, `drive.file`, conversion, OCR và write API bị từ chối; canvas substitution chỉ là experimental evidence riêng.
- Drive Office download giới hạn 20 MiB/30 giây, dùng bounded ordered stream vào extension memory rồi parse bằng Worker hiện có. Reader hiển thị workbook order và worksheet selector riêng, mặc định worksheet đầu tiên; không scrape/mirror Google active tab, poll, hoặc cam kết lấy unsaved editor state. **Refresh** tạo saved snapshot mới. `.xlsm` chỉ read-only với `bookVBA: false`; không execute/expose/preserve/write/export macro. Bytes/metadata không đi backend/provider; chỉ visible textual cells được gửi sau explicit **Translate**.
- Trước grid paint đầu tiên, Sheets dùng allocated `columnCount` chỉ làm search boundary, scan các chunk 32 cột từ phải sang trái với đúng một request pending, rồi dựng immutable absolute column array A..rightmost data column. Internal blank/hidden positions giữ nguyên; response order hoặc mounted DOM order không được compact/reorder/expand cột.
- Discovery đọc active-sheet values trong bounded batches chỉ để tìm absolute final column rồi discard ngay. Values này không được persist, log, hiển thị trong Reader, translate hoặc gửi provider. Mỗi Google response giới hạn 2 MiB; oversized/timeout range split theo rows rồi columns tới một cell. `429`/timeout/temporary failure pause cursor để user chọn **Continue discovery**, không restart completed chunks hoặc silently poll.
- Sheets load source/layout theo logical page chính xác 100 rows; khi tới final 20 loaded rows thì request page kế một lần. Distant pages được evict/reload để giữ tối đa 10.000 resident populated records và 256.000 resident source characters; một page không thể fit phải fail `content-too-large` trước provider dispatch.
- Native Sheets và Drive/local spreadsheet dùng chung control shell: inline **Worksheet | Provider | Translate to**, stable **Translate | Stop**, **Translation / Original**, Refresh/Clear và connection footer. `Translate` đổi thành spinner + **Translating…**, rồi disabled **Translation on**; **Stop** luôn giữ vị trí và chỉ enabled khi translation active. Presentation disabled tới khi có result. Completion count chỉ announce cho assistive technology; visible status chỉ dành cho partial/warning/error.
- Sau đúng một explicit **Translate**, Sheets translate viewport cộng một viewport phía trước, giữ một Reader translation message pending, adapter concurrency `2`, tối đa 128 records/8.000 aggregate characters mỗi message và 4.000 units mỗi record. Translation thay source text trực quan; global **Translation / Original** chỉ đổi presentation, không dispatch hoặc xóa accepted translations. Selected-cell details expose cả source và translation. Khi `translating`/`watching`, primary bị disabled nên click lần hai không tạo generation/provider call mới.
- Mặc định Reader target là Vietnamese khi chưa lưu lựa chọn; giữ provider/target qua worksheet/file/adapter changes. Click icon trên supported spreadsheet editor khi signed in mở trực tiếp SidePanel, load-only; unsigned mở login popup. File mới giữ panel nhưng chờ Translate; về Drive list/folder/trang không liên quan ẩn panel và dừng work, quay lại không tự mở/dịch. CSV/file URL không có readable-byte capability dùng popup/local picker guidance.
- Reader bind file trong source browser tab; dropdown sở hữu worksheet độc lập với editor gid. Browser sheet change trong cùng file giữ nguyên worksheet/content của Reader, zero discovery/provider; connection vẫn giữ nguyên. Rapid A → B → C chỉ commit C; Refresh giữ Reader-selected worksheet trong bound file.
- Native Sheets metadata cung cấp Reader-owned dropdown cho mọi supported `GRID` sheet mà không thêm catalog request. Dropdown chỉ đổi Reader, không đổi Google editor. Idle dropdown selection chỉ load; active selection giữ provider/target và tự tiếp tục viewport translation khi grid mới sẵn sàng. Popup Translate intent tiếp tục sau Connect/source loading; direct-open Reader vẫn load-only. Stop, Clear view, Disconnect Google/logout, teardown, settings change hoặc chuyển file phải dừng continuation.
- **Disconnect Google** nằm ở connection footer cho native/Drive spreadsheet, độc lập với source version, dừng active work và clear Google token; button disabled chỉ trong lúc disconnect. Readlace managed session không bị sign out.
- Sheets column width là `clamp(1px, API pixelSize hoặc 100px, 420px)`. Cell giữ newline, break long lines, có thể tăng row height cao hơn API minimum và không ellipsize translated text. Sticky headers và API frozen/hidden/merged/RTL structure được giữ với visible-plus-two-column overscan; không tạo cells ngoài loaded pages.
- Docs chỉ load active Docs tab trong supported three-level tab topology. Docs GET dùng fixed narrow fields mask cho `documentId`, tab properties/topology và paragraph/unsupported/table content, gồm nested table cells; không fetch document không giới hạn. **Translate loaded** và **Translate selected** tiếp tục áp dụng cho Docs cards. Reader không inspect, move hoặc claim live selection/cursor trong Google editor.
- Mỗi operation re-derive file/sheet/tab identity từ source tab hiện tại; Reader không được chọn file ID, API URL, method, header hoặc body. Reader reuse primary `translateText()` adapter, cache validation/namespaces và concurrency `2`; không tạo page run, fallback loop, browser-native stage, history, provider endpoint hoặc cache namespace mới.
- Mọi API/provider text render dưới dạng plain text. Late/mismatched result theo source tab, file/sheet/Docs-tab, source hash, provider, target, request ID hoặc managed-account generation không được update Reader.
- Exact Google editor route suppress manual/automatic DOM page translation. Other websites, non-editor Google pages, saved site preferences và page/selection behavior hiện tại không đổi.

### US-09 — Đọc và dịch file spreadsheet local

**Là** người dùng có file `.csv`, `.xlsx` hoặc `.xlsm`, **tôi muốn** mở file trong Readlace Reader bằng file picker/drag-drop, **để** đọc bản dịch theo đúng vị trí cell mà không upload, sửa hoặc export file.

**Acceptance criteria**

- Popup chỉ hiển thị compact secondary tool **Open local spreadsheet** sau khi managed account đã sign in. Action mở đúng `/reader.html?local=1` trong normal extension tab và đóng popup sau khi tab tạo thành công; failure giữ popup mở với error. Readlace không intercept browser/Office viewer.
- Chỉ file user chọn rõ ràng được đọc. Parsing chạy trong dedicated Worker; bytes không upload, persist, log, cache hoặc gửi provider. Google OAuth/Google APIs không cần thiết; translation vẫn yêu cầu managed Readlace login.
- Hỗ trợ nhiều worksheet; giữ worksheet order, absolute A1/internal blanks, values, formulas với cached display nếu có, merges, row/column sizes, hidden dimensions và best-effort basic styles. Không tính lại formula; không hỗ trợ chart, image, pivot, conditional formatting, external refresh hoặc exact Excel fidelity.
- `.xlsm` chỉ read-only với `bookVBA: false`; không execute, expose, preserve, write, download hoặc export VBA. Password-protected/encrypted workbook fail rõ ràng. Reader không edit/save/export file.
- Limits cố định: 20 MiB/file, 50 sheets, 100.000 used rows, 16.384 columns, 10.000 populated records, 256.000 source UTF-16 units mỗi selected sheet và parse timeout 15 giây.
- Explicit **Translate** chỉ gửi visible untranslated textual cells, tối đa 128 records/8.000 aggregate units và 4.000 units/record. Translation/Original chỉ đổi presentation. Idle worksheet selection không dispatch; active selection tiếp tục dịch visible cells của sheet mới mà không parse lại file. **Stop** dừng continuation; **Clear view** kết thúc Worker và quay lại chọn file.

## 4. Scope MVP

### Trong scope

- Best-effort, site-agnostic trên mọi website, bao gồm page yêu cầu login.
- Chrome/Chromium.
- Text hiển thị trong DOM: text tĩnh, menu, tab, modal và nội dung động.
- Auto-detect source language.
- Target language EN/VI/JA.
- Translate, Show original và Always-translate theo website.
- Clear saved translations đồng thời xóa OpenAI, Google và OpenAI-chain cache cùng local aggregate diagnostics nhưng không xóa settings, target language hoặc Always-translate preference.
- Duy trì state qua navigation và reload.
- Tooltip cho text bị rút gọn.
- Google/OpenAI provider keys chỉ nằm trong backend environment; extension không có provider-key UI hoặc storage.
- Managed accounts dùng email/password, opaque rotating sessions và operator-only create/reset endpoints được bảo vệ bởi `ACCOUNT_PROVISIONING_TOKEN`; `pnpm account:create` là CLI wrapper cho create endpoint.
- Browser-native Translator là free best-effort recovery cho residual records sau Google trong cả OpenAI-selected chain và Google-selected run, được feature-detect thay vì browser-sniff và không phải provider thứ ba trong UI.
- Chromium-only Google Workspace Reader cho native Google Sheets/Docs và Drive-hosted Office saved snapshots, dùng một package web OAuth chung cho desktop Chrome/Comet/Edge, read-only APIs và extension-owned side panel/tab fallback mà không ghi vào source.
- Local Spreadsheet Reader cho explicit `.csv`/`.xlsx`/`.xlsm` selection trong extension tab, read-only, local-byte parsing và visible-cell translation.

### Ngoài scope hoặc giới hạn

- Text nằm trong ảnh.
- Text user nhập trong input.
- Tự động phát hiện sensitive content.
- Cam kết chất lượng tuyệt đối trên mọi website.
- Production hosting selection, MFA, billing/subscription/business quota và privacy controls đầy đủ.
- Companion app, setup wizard, manual model/language-pack install và bundled model.
- Các target language ngoài EN/VI/JA.
- Browser/Office viewer interception ngoài exact Google Sheets Office route, workbook editing/export, VBA execution/preservation, exact Excel rendering, charts/images/pivots/conditional formatting, Google editor overlay, live editor selection/cursor sync, Drive conversion, Picker, `drive.file`, OCR và Google write APIs.

## 5. Demo acceptance

Demo thứ Ba đạt khi thực hiện được chuỗi sau trên bộ sample đã chọn:

1. Mở popup và chọn EN, VI hoặc JA.
2. Chọn **Translate** trên page.
3. Kiểm tra text tĩnh, menu/modal hoặc nội dung động.
4. Điều hướng trong website và reload page.
5. Xác nhận page vẫn tự động dịch theo preference.
6. Đổi target language và xác nhận dịch lại từ nội dung gốc.
7. Chọn **Show original** và xác nhận nội dung gốc hiện lại.
8. Kiểm tra layout integrity và tooltip của text bị ellipsis.
9. Mô phỏng retryable API/quality miss và xác nhận OpenAI-selected record theo đúng `3 OpenAI + 1 Google + 1 browser-native`; stage tuần tự, accepted record không đi tiếp, `auto` không vào native, selected Google giữ Google → native isolation, `partial` hiển thị **Translate** sau khi hết budget, và không có Retry control.
10. Xác nhận warm accepted records và scroll-back có zero provider request; warm full reuse không quá 500 ms và nhanh hơn cold cùng máy ít nhất 50%; scroll dispatch không quá 600 ms, delayed retry không chặn record mới eligible, và deterministic commit không quá 1.500 ms.

Google Workspace Reader có demo riêng trên disposable native và Drive-hosted Office fixtures: build một artifact với Web application client rồi load đúng artifact đó vào Chrome, Comet và Edge; explicit **Connect Google Workspace** phải re-consent cả restricted `drive.readonly`. Native/Drive spreadsheet phải dùng cùng inline fields và stable actions ở 320px/expanded panel, không page overflow hoặc visible completion line. Native Reader dropdown idle load với zero provider, active dropdown continue một lần; browser worksheet change giữ nguyên Reader worksheet/content và zero discovery/provider. Disabled **Translation on** không tạo duplicate request/React #185; **Stop** và presentation vẫn usable. **Disconnect Google** phải thành công sau source change. Mở `.xlsm`/`.xlsx` ở Google Sheets Office mode phải chuyển adapter trong common `/reader.html` panel, không local picker, hiển thị latest saved snapshot/worksheet selector, và chỉ gửi visible cell text khi Translate. Refresh tải snapshot mới; unsaved state, active Google worksheet, conversion, macro, write/export không được claim. Deterministic proof không thay configured live Drive API/re-consent/provider/installed-runtime evidence riêng cho từng browser.

Local Spreadsheet Reader có demo riêng bằng synthetic CSV/XLSX/XLSM: authenticated popup tool mở normal extension tab rồi đóng popup; picker/drop hiển thị đúng worksheet/grid, quoted commas/multiline CSV, A1 gaps, formula/merge/dimensions; idle worksheet selection có zero provider, active selection tiếp tục visible translation. Network observation xác nhận zero file upload/write/export. XLSM không expose/execute/preserve VBA và encrypted workbook fail rõ ràng.

Reader regression phải mở XLSX và XLSM bằng toolbar thực vào global `/reader.html`, capture original Port sender, rồi xác nhận parse, Translate và Refresh hoạt động; source-bound extension tab không thay được proof này. Pre-start native catalog phải hiển thị tên thật thay vì gid, cho chỉnh Provider/Translate to, giữ lựa chọn qua metadata-only dropdown/Refresh và chỉ dịch worksheet chọn cuối khi Translate. Office awaiting-start hiển thị placeholder, không tải media để lấy tên worksheet. Lỗi channel của extension và lỗi Google phải được phân biệt, có Refresh recovery, và response cũ/cross-window không được dispatch hoặc commit.

## 6. Rủi ro MVP

- Hosting target chưa được chọn và repository không chứa platform-specific deployment descriptor. Provider, provisioning, database và session secrets không được commit, build, log hoặc trả về extension.
- Text page có thể chứa sensitive content và được gửi tới selected cloud provider; với OpenAI-selected run, unresolved text có thể được gửi tiếp tới Google fallback. Không dùng MVP với dữ liệu nhạy cảm thực tế.
- DOM và layout khác nhau giữa các website; phạm vi “mọi website” là best-effort.
- Record granularity làm tăng số storage key; bulk I/O và aggregate diagnostics được đo trước khi bổ sung eviction. Phân loại English/Vietnamese Latin text ngắn vẫn best-effort.
- Chrome docs công bố Translator stable cho desktop extensions từ Chrome 138+, nhưng tài liệu chung cũng nói API không khả dụng trong Web Workers. Installed runtime phải feature-detect capability và fail closed; live capability proof hiện có: Chrome 151 cold khoảng 15.8 giây/warm khoảng 120 ms; Comet 151.0.7922.249 cold khoảng 17.5 giây/warm khoảng 299 ms. Edge 151.0.4129.107 nhận đúng CDP/trusted click nhưng không có progress trong 90 giây; product watchdog kết thúc native path là unavailable sau 30 giây để run không treo.
- Deterministic order/count/cache/provenance tests không thay thế authenticated OpenAI → Google, installed browser-native, Office Sheets Man/provider hoặc live Asahi/Wikipedia/Yahoo proof; unavailable auth, network, browser model hoặc external markup là proof boundary, không phải pass.
- Google Workspace Reader dùng sensitive Docs/Sheets scopes và restricted `drive.readonly`, cho phép xem/download mọi Drive file account có quyền truy cập. Internal/Testing có audience constraints; public production có thể cần restricted-scope verification và third-party security assessment. Live support chỉ được claim riêng cho Chrome, Comet và Edge sau khi cùng một artifact dùng Web application client/exact redirect đã được kiểm chứng với enabled Docs/Sheets/Drive APIs, real re-consent, installed runtime và disposable native/Office fixtures. Source, mocked OAuth và deterministic pass không thay thế live evidence; cả ba browser vẫn Blocked/Not run cho tới khi được quan sát riêng.
