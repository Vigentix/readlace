# Spreadsheet Readers setup and operation

Current support: native Google Sheets behind a remote flag, and local workbooks. **Google Docs is temporarily unsupported**; Docs-specific instructions below are inactive future context. **Drive-hosted Office workbooks are disabled at launch** (no Drive scope); Drive-specific instructions below describe the dormant path that returns with `drive.file` and Google Picker.

## Launch scope (ADR 0015)

- **No required Google permission.** The manifest requires only `tabs`, `scripting`, `<all_urls>`, and — in builds with `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID` — `sidePanel` and `storage` (neither shows an install warning). `identity` is in `optional_permissions` and `https://sheets.googleapis.com/*` is in `optional_host_permissions`. Reader requests both with `permissions.request` synchronously inside the **Connect Google Workspace** click (Chrome rejects a request after an `await`). Because they are optional, enabling Workspace later never disables the installed extension. Neither normally shows a prompt: `identity` carries no warning and `<all_urls>` already covers the API host. Declining shows "Allow Google access…" and makes no OAuth request.
- **One OAuth scope:** `spreadsheets.readonly` (sensitive). `documents.readonly` and the restricted `drive.readonly` are not requested, so no CASA assessment is needed. Submit OAuth verification for `spreadsheets.readonly`.
- **Build flag, default off (ADR 0020).** The native Sheets Reader is enabled only in builds with `WXT_SHEETS_READER=true`, read on every Reader request; the earlier remote flag and its `GET /v1/features` endpoint are gone with the backend. Turn it on only after Google verifies the OAuth client for `spreadsheets.readonly`.
- **Flag off:** the toolbar keeps the popup on a native Sheet. The popup shows "Reading Google Sheets directly is coming soon." with **File → Download → Microsoft Excel (.xlsx), then open it in Local Reader** and an **Open local spreadsheet** action (the Local Reader at `/reader.html?local=1`). A Reader that is already open shows the same notice and action. Builds without the Workspace client ID show the same notice. Google Docs keeps its own unavailable state.
- **Drive Office workbooks:** with only `spreadsheets.readonly`, Reader identifies a native Sheet through the Sheets API (`fields=spreadsheetId,properties(title)`). The Sheets API refuses a Drive-stored `.xlsx`/`.xlsm` opened in Office mode (`400`), so Reader shows `office-download-required` with the same download steps and **Open local spreadsheet**. The background also refuses any Drive download Port with that code. The Drive metadata/media code stays behind `driveOfficeReaderEnabled()` (false) and keeps its tests for the Picker release.
- A session token issued before this build carries the old three scopes and is rejected; users reconnect once.

Workbook parsing bounds both input and aggregate expanded ZIP content to 20 MiB and accepts at most 4,096 ZIP members. Unsupported ZIP64/multidisk/encrypted or inconsistent archives fail before SheetJS parsing. Saved frozen panes, RTL, gridlines, row heights and shared/inline rich text are read from bounded OOXML metadata; translation style mapping remains approximate. Charts/images and formula calculation remain unsupported.

Each Reader owns its worksheet/source generation independently. Partial translation can continue untouched visible cells; oversized cells do not block other rows. Refresh retains an active authorized continuation after metadata/source validation, while Stop then Refresh remains idle. A 30-second waiting notice retains the in-flight slot until the request actually settles; it does not claim the remote operation was cancelled.

Google Workspace Reader displays a read-only grid for the active native Google Sheet, translated cards for the active Google Docs tab, or a Reader-owned grid for the latest saved snapshot of a Drive-hosted `.xlsx`/`.xlsm`. It never writes to the file or overlays the Google editor. The preferred surface is a window-scoped Chromium side panel; the browser owns its resizable width and Reader fills the available space. The same `/reader.html` page opens in a normal extension tab when the side-panel API is unavailable or rejects the open request.

Local Spreadsheet Reader is a separate Chromium surface at `/reader.html?local=1` for explicit `.csv`, `.xlsx`, and `.xlsm` file selection. It opens in a normal extension tab, does not use Google OAuth or intercept browser/Office viewers, and never changes or exports the selected file.

## Authentication boundaries

Two independent authorizations are required:

1. **Readlace identity** — there are no Readlace accounts (ADR 0020). The extension uses one local identity, and the user's own provider key (Settings) authorizes translation.
2. **Google Workspace access** — the portable Chromium web OAuth flow grants read-only access to Google Sheets. It does not sign the user into Readlace and cannot create, exchange, store, or refresh a Readlace session.

Google Workspace access uses exactly this scope (ADR 0015):

- `https://www.googleapis.com/auth/spreadsheets.readonly`

`documents.readonly` and the restricted `drive.readonly` were removed for the commercial launch.

One public `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID` identifies a Google OAuth client whose application type is **Web application**. The same configured Chromium package is loaded in desktop Chrome, Comet, and Edge. The extension derives the redirect with `browser.identity.getRedirectURL("google-workspace")`; with the committed extension identity it must equal:

```text
https://imlhpiikjakgljngkdalbfgdpkniejdb.chromiumapp.org/google-workspace
```

The legacy `WXT_GOOGLE_WORKSPACE_CLIENT_ID` and Chrome-extension OAuth client mode are no longer supported. Remove that variable before building; its presence fails the build with a migration error. The public web client ID is a build identifier, not a secret. Google Cloud may display a client secret for the Web application client, but the extension never uses it: do not copy, share, or configure it. Do not configure a Google API key.

The access token is a versioned record in `browser.storage.session`, restricted to trusted extension contexts and bound to the current client ID, extension ID, exact scopes, expiry, and Readlace managed account. A record issued for the former three-scope set no longer matches and is cleared, so existing users choose **Connect Google Workspace** once after installing this build. A valid token survives an MV3 service-worker restart within the browser session. It is never copied to local/sync storage, IndexedDB, runtime messages, pages, logs, diagnostics, the Readlace backend, or provider payloads. Reader clears it after expiry/invalid metadata, Google `401`, **Disconnect**, managed logout/account change, or OAuth configuration change; browser/extension lifecycle clears session storage. A browser restart clears session storage and may require **Connect Google Workspace** again.

## Supported surface

- Chromium builds only.
- Native Google Sheets at `https://docs.google.com/spreadsheets/d/<id>/edit...`.
- Native Google Docs at `https://docs.google.com/document/d/<id>/edit...`.
- Drive-hosted `.xlsx` and `.xlsm` files opened at an exact Google Sheets editor route are **disabled at launch**: the Sheets API `400` shows the download guidance (see Launch scope). When the Drive path returns, validated Drive metadata identifies Office mode; the common global panel remains `/reader.html`; no local file picker appears.
- Only an active native Sheets `GRID` sheet uses the spreadsheet-like grid. Before first paint, Reader discovers the effective rectangle `A1:lastUsedCell`, preserves every internal blank/hidden row and column, and then loads source/layout in logical 100-row pages. Allocated `rowCount` and `columnCount` are search ceilings only; they do not define rendered scroll space or paging.
- Discovery starts with 32-column chunks from right to left, doubles confirmed-empty chunks up to 512 columns, and resets the next chunk to 32 after a split. Each fragment yields rightmost-column and last-row evidence. If the completed column evidence does not cover A through the discovered rightmost column, Reader scans rows from the allocated bottom upward across that column range, starting with 100 rows and doubling fully empty chunks. The existing live status reports **Discovering columns…** or **Discovering rows…** for the active phase. One request remains pending.
- A source value counts toward the boundary when it is non-empty text, a number, a boolean, or a formula returned with `valueRenderOption=FORMULA`; a formula counts even when its displayed result is empty. Empty strings, missing values, formatting-only cells, notes, and blank merges do not extend the range. Reader discards discovery values immediately; they are never retained in background or Reader state, storage, messages, logs, diagnostics, cache, translation history, or provider payloads.
- Approaching the final 20 loaded rows requests the next 100-row page once, bounded by the discovered last used row; the final page may be shorter and an empty sheet performs no page read. A fully empty logical page inside `A1:lastUsedCell` may still be read because Reader does not keep an occupancy index. After one explicit **Translate** action, provider work covers the viewport plus one viewport ahead with one Reader translation message pending; a viewport without untranslated translatable records sends no provider request.
- Clicking **Translate** in the Sheets popup carries that request and target into Reader, including an already-open panel or the extension-tab fallback. After any required Google connection and source loading, translation begins without a second click. Opening Reader directly remains load-only. The one-shot request expires after five minutes and is bound to the source and signed-in account.
- Reader file and worksheet ownership are separate. Within one native spreadsheet file, editor `gid` changes leave Reader selection/content unchanged and perform zero discovery/provider work. The Reader dropdown is authoritative; Refresh retains that selection and latest dropdown responses win. The target is a saved Reader preference shared by native, Drive and local adapters (there is no Provider control; the backend routes engines); Vietnamese is the default only when no valid Reader target has been saved. A different supported file retires old data/work, identifies the current metadata-approved native/Office source, and waits for Translate before value discovery or provider dispatch. Drive lists/folders and unrelated pages close the panel in the affected browser window and retire work; returning never opens or translates automatically. Signed-in supported-editor toolbar clicks open Reader directly with no provider intent; unsigned users and ordinary sites keep the popup. Unsupported raw CSV/file URLs retain popup/local-file guidance rather than claiming readable-byte support.
- Native Sheets exposes the complete supported `GRID` worksheet catalog through a bounded metadata-only Context read before Translate on a newly selected file. Names come from metadata, never raw `gid`. Pre-start dropdown selection and **Refresh** update validated metadata/selection only, with zero values, discovery scans or provider requests. Dropdown selection changes Reader only and never navigates, scripts, scrapes, overlays, or mutates Google's editor. After loading, idle selection loads without provider work. Selection during `translating`/`watching` retires the prior generation and continues visible translation after the selected sheet is ready. Popup Translate intent continues after any required Google connection/source load. **Stop**, **Clear view**, **Disconnect Google**, managed logout, Reader teardown, navigation to another file, or changing the target stops continuation; changed settings require **Translate** again. Loaded **Refresh** validates the bound file, retains the Reader-selected worksheet, and recomputes both bounds. Content added outside the current boundary appears after loaded **Refresh** or another source-generation restart; Reader does not poll for it.
- Native Sheets and Drive/local spreadsheets use the same inline **Worksheet | Translate to** row and stable **Translate | Stop** action row. Source discovery/loading disables source-dependent actions. Translation loading appears as spinner plus **Translating…** in the primary button; settled active translation is disabled **Translation on**. **Stop** stays visible and is disabled outside active translation. **Translation / Original** stays disabled until a result exists. Completion counts use a visually hidden polite announcement; visible status is reserved for actionable partial, warning, or error messages.
- Sheets translation replaces source text visually. The global **Translation / Original** control changes presentation without dispatching work or clearing accepted translations; selected-cell details expose both values.
- Docs keeps its record-card UI, reads the active Docs tab, and loads another known tab only after the user selects it in Reader. **Translate selected** means checked Docs records inside Reader; it does not read or move the live Google editor cursor or selection.
- Sheets columns use the API pixel size or `100px`, clamped from `1px` to `420px`. Cell text preserves newlines, breaks long lines, and can grow row height above the API minimum; translated grid text is not ellipsized.

For a Drive Office file, background code re-derives the file ID from the bound source tab, fetches fixed Drive metadata and media endpoints, and streams at most 20 MiB to Reader in bounded base64 chunks. Reader assembles one in-memory snapshot and reuses the local spreadsheet Worker/grid. It initially shows the workbook's first worksheet and exposes its own worksheet selector; it does not map Google `gid` to an Office worksheet. **Refresh** downloads another latest saved snapshot. Reader does not poll and cannot guarantee inclusion of edits that Google has not saved to Drive.

The connected idle **Translate to** control remains editable before content exists. Before an Office file is explicitly started after a source transition, its disabled worksheet field shows **Translate to load worksheets**; the extension does not download a workbook merely to populate that field.

The bare global panel URL authenticates only the extension surface. Each Drive attempt first establishes a Context binding for the Reader document/owner, actual browser window/source tab, current file/version and managed account. An ambiguous or retired binding cannot read a file. **Reader could not connect to the extension background** denotes a local channel failure; **Google Drive is temporarily unavailable** is reserved for an explicit Google/network failure. Refresh re-establishes the current binding and starts a new attempt.

Installed Chrome can omit document identity on Side Panel messages/Ports while returning `windowId=-1` from `runtime.getContexts()`. Exactly one browser-reported Reader document can be correlated with its actual confirmed panel open. If multiple Reader documents make that association ambiguous, the panel makes no source request and offers **Open Reader in a tab**. This explicit fallback opens a source-bound Reader tab in the source's browser window; it does not take over another window's Reader. This capability limit is separate from Google access and does not establish equivalent Comet/Edge behavior.

Drive Office handling is read-only and does not convert, edit, save, download to disk, export, execute, expose, or preserve macros. Downloaded bytes and metadata remain within trusted extension contexts and are discarded after parsing/teardown; they are never sent to Readlace or a translation provider. Only visible textual cell values are sent to the backend translation stage after explicit **Translate**. Drive Picker, `drive.file`, OCR, overlays, and every Google write API remain excluded.

Used-range behavior follows the Google Sheets API v4 contracts for [ValueRange](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values), [`valueRenderOption`](https://developers.google.com/workspace/sheets/api/guides/values), and [GridProperties](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets). Google omits trailing empty values from returned value arrays, while the response range remains the requested range and allocated grid dimensions remain capacity rather than content bounds. The bounded requests also follow Google's [usage-limit](https://developers.google.com/workspace/sheets/api/limits) and [field-mask](https://developers.google.com/workspace/sheets/api/guides/field-masks) guidance.

## Local Spreadsheet Reader

Choose the compact **Open local spreadsheet** popup tool, then select or drop one `.csv`, `.xlsx`, or `.xlsm` file. A successful Reader-tab open closes the popup, while an open failure leaves the popup available with an error. File selection is explicit; Readlace never infers a path or reads a file from an existing browser/Office viewer. Parsing occurs in a dedicated extension Worker. File bytes are transferred only to that Worker and are never uploaded, persisted, logged, cached, or sent to a provider. Google authorization and APIs are not used. Translation sends only visible untranslated textual cell values through the existing provider path (the user's own key, or on-device).

The normalized grid preserves worksheet order, absolute A1 positions/internal blanks, values, formulas with available cached display, merges, row/column sizes, hidden dimensions, and best-effort basic styles. The browser does not calculate formulas, so cached results may be missing or stale. Charts, images, pivots, conditional formatting, external links/data refresh, and exact Excel rendering are outside the supported fidelity boundary.

Saved Office geometry uses the workbook's Normal-font maximum digit width measured once in the Worker; when that browser measurement is unavailable, the saved pixel-width fallback remains. Positive narrow columns are retained down to one pixel, with a 420px display ceiling and a 100px missing-width fallback. Bounded OOXML worksheet relationships and fixed style tables restore source fills, text colors, bold/italic, alignment, wrapping and side-border colors, including styled blank cells. The Reader uses compact cell padding and a 21px default row estimate; rows grow only when saved height or visible content requires it. Exact font size/family rendering, border thickness/dash patterns and conditional formats are unsupported.

The Normal font follows its saved style mapping when present; font zero is used only when that metadata is absent. An explicitly invalid mapping or unavailable browser font measurement uses the pixel fallback rather than guessing a font. Persisted document/window association metadata is revalidated after worker restart; Reader-owner, source/version and account authorization bindings are always rebuilt fresh.

Within the same browser session, a background restart restores and revalidates the browser document/window association metadata. Refresh on a loaded Office view confirms the Root-expected file before adopting the fresh background version and downloading a new snapshot; another Google consent is unnecessary while the existing token is valid. This does not authorize a different file or revive retired work. Deterministic installed-Chromium tests separately cover actual worker stop/new-isolate recovery, repeated worksheet changes and saved synthetic layout; those fixtures do not prove live Google or Comet/Edge behavior.

`.xlsm` support is read-only. Parsing sets `bookVBA: false`; Readlace does not execute, expose, preserve, write, download, or export macros/VBA. Password-protected or encrypted workbooks fail explicitly. Local Reader has no edit, save, download, or export action.

One explicit **Translate** schedules visible untranslated textual cells through the common spreadsheet controls. **Translation / Original** changes presentation only. An idle worksheet selection reuses the parsed workbook without provider work; selection while translation is active continues with visible untranslated cells on the selected worksheet. **Stop** retires the active generation and disables future automatic continuation; **Clear view** terminates the Worker and returns to file selection.

## Create the Google Cloud configuration

Use a project intended for this internal Reader build. Google Cloud Console labels can change, but the resulting configuration must satisfy every item below.

1. Select or create a Google Cloud project.
2. Enable **Google Sheets API** for that project (ADR 0015; Docs and Drive APIs are not used at launch).
3. Configure the OAuth consent screen/Google Auth Platform branding and audience.
4. Add only `spreadsheets.readonly`.
5. Choose the audience/status deliberately: **Internal** limits use to the Workspace organization and normally avoids public verification; **External / Testing** requires every verification account under **Test users** and is suitable only for controlled trials; **External / In production** with restricted `drive.readonly` requires Google's restricted-scope verification and may require an independent security assessment. Organization administrators can still block or allowlist the app/scopes.
6. Create one **Web application** OAuth client for the shared Chromium package.
7. Add exactly `https://imlhpiikjakgljngkdalbfgdpkniejdb.chromiumapp.org/google-workspace` under **Authorized redirect URIs**. This is the value returned by `browser.identity.getRedirectURL("google-workspace")` when the installed extension ID is `imlhpiikjakgljngkdalbfgdpkniejdb`.
8. Copy the public client ID ending in `.apps.googleusercontent.com` into `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID`. Do not copy, expose, or configure its client secret.

`spreadsheets.readonly` is sensitive, not restricted: public use needs OAuth app verification but no CASA assessment (ADR 0015). Internal or External/Testing test-user setup is sufficient for controlled feasibility work within its audience boundary; an unverified app is limited to 100 users and shows a warning screen. Keep `FEATURE_WORKSPACE_SHEETS_READER` off until verification passes.

Primary references: [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity), [Google browser OAuth flow](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow), [Google Docs authorization scopes](https://developers.google.com/workspace/docs/api/auth), [Google Sheets authorization scopes](https://developers.google.com/workspace/sheets/api/scopes), [Google Drive scopes and verification](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), and [Google OAuth consent setup](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

Chrome, Comet, and Edge use the client-side implicit response because the approved Reader boundary forbids a backend-held Google token/client secret. Google recommends an authorization-code model for broader production integrations. Before public distribution, review whether to move Google authorization/token exchange to a separately approved backend design; that would change ADR 0012 and is outside this internal Reader configuration.

The operator performs project creation, API enablement, scopes, audience/test-user setup, OAuth client creation, redirect registration, and extension build once. Each user still chooses **Connect Google Workspace** and completes Google account selection/consent in each browser session that needs Reader access. Existing users must reconnect once for `drive.readonly`; users do not enable APIs or create OAuth clients.

## Build and inspect the configured Chromium package

Run from PowerShell 7. Replace the example with the public Web application client ID. Project-specific values should not be committed accidentally.

Migrate any existing configuration by deleting `WXT_GOOGLE_WORKSPACE_CLIENT_ID` from `.env`, the shell environment, CI, and build secrets, then set `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID`. `Remove-Item Env:...` clears the current PowerShell process only; WXT can still reload a legacy value from `.env`.

Build the one Chromium artifact used by Chrome, Comet, and Edge:

```powershell
Set-Location -LiteralPath 'D:\tryhand-project\web-app-translated-extension'
$env:WXT_BACKEND_URL = 'http://localhost:10000'
Remove-Item Env:WXT_GOOGLE_WORKSPACE_CLIENT_ID -ErrorAction SilentlyContinue
$env:WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID = '123456789012-your-web-client.apps.googleusercontent.com'

pnpm build
if ($LASTEXITCODE -ne 0) { throw "Chromium build failed with exit code $LASTEXITCODE." }

node scripts/verify-workspace-reader-manifest.mjs --mode enabled-web .output/chrome-mv3/manifest.json
if ($LASTEXITCODE -ne 0) { throw "Portable Reader manifest verification failed with exit code $LASTEXITCODE." }
```

The check requires Web application client mode, required `tabs`/`scripting`/`sidePanel`/`storage` and `<all_urls>` only, optional `identity` and optional `https://sheets.googleapis.com/*` (ADR 0015), `/reader.html`, and the fixed redirect contract without native manifest OAuth metadata. Runtime OAuth scopes are not stored in the manifest; their exactness is covered by the authorization contract tests and Google re-consent. `storage.session` holds the bounded popup-to-Reader intent and trusted session token; it never holds cell values, and the token never enters persistent storage. A malformed web client ID or any legacy native client configuration fails rather than creating a partially configured build.

Unpacked internal builds must keep the manifest `key` (stable extension ID). The Chrome Web Store package from `pnpm build:store` (ADR 0016) must not carry one; verify it with `--store`, which applies the same permission contract and requires `key` to be absent:

```powershell
node --env-file-if-exists=.env scripts/verify-workspace-reader-manifest.mjs --mode enabled-web --store .output/store/chrome-mv3/manifest.json
```

When the client ID is stored only in `.env`, direct `node` commands do not load that file automatically. Use the web mode and Node's env-file option:

```powershell
node --env-file-if-exists=.env scripts/verify-workspace-reader-manifest.mjs --mode enabled-web .output/chrome-mv3/manifest.json
```

To prove the optional configuration remains optional without reading or editing a real `.env`, temporarily move that file and always restore it:

```powershell
Set-Location -LiteralPath 'D:\tryhand-project\web-app-translated-extension'
$readerEnv = Join-Path (Get-Location) '.env'
$readerEnvBackup = Join-Path (Get-Location) '.env.workspace-reader-backup'
$readerHadEnv = Test-Path -LiteralPath $readerEnv

if (Test-Path -LiteralPath $readerEnvBackup) {
    throw "Refusing to overwrite existing $readerEnvBackup"
}

if ($readerHadEnv) {
    Move-Item -LiteralPath $readerEnv -Destination $readerEnvBackup -ErrorAction Stop
}

try {
    $env:WXT_BACKEND_URL = 'http://localhost:10000'
    Remove-Item Env:WXT_GOOGLE_WORKSPACE_CLIENT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID -ErrorAction SilentlyContinue

    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Unconfigured Chromium build failed with exit code $LASTEXITCODE." }

    node scripts/verify-workspace-reader-manifest.mjs --mode disabled .output/chrome-mv3/manifest.json
    if ($LASTEXITCODE -ne 0) { throw "Unconfigured manifest verification failed with exit code $LASTEXITCODE." }
}
finally {
    Remove-Item Env:WXT_GOOGLE_WORKSPACE_CLIENT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:WXT_BACKEND_URL -ErrorAction SilentlyContinue

    if ($readerHadEnv) {
        if (Test-Path -LiteralPath $readerEnv) {
            throw "Cannot restore .env because a new .env now exists. Original remains at $readerEnvBackup"
        }
        Move-Item -LiteralPath $readerEnvBackup -Destination $readerEnv -ErrorAction Stop
    }
}
```

That build keeps ordinary page and selected-page-text translation functional. It omits Google OAuth metadata, Google API hosts, required and optional `identity`, `sidePanel`, `storage`, and the Reader manifest entrypoint; the popup shows the Sheets coming-soon notice with **Open local spreadsheet** on a native Sheet. A Store build may ship this way while the remote flag is off; the release scan accepts its inert Reader auth code because the manifest cannot grant `identity` (see `scripts/scan-release-secrets.mjs`).

## Load or reload the extension

1. Build with the real public client ID as shown above.
2. Open the target browser's extension page: `chrome://extensions`, `comet://extensions`, or `edge://extensions`.
3. Enable **Developer mode**.
4. If Readlace is not loaded, choose **Load unpacked** and select `D:\tryhand-project\web-app-translated-extension\.output\chrome-mv3`.
5. If Readlace is already loaded, choose **Reload** on its card after each rebuild.
6. Confirm the displayed extension ID is exactly `imlhpiikjakgljngkdalbfgdpkniejdb`. A different ID produces a different `chromiumapp.org` redirect and will not match the configured Web application client.

Use the exact same `.output/chrome-mv3` bytes in Chrome, Comet, and Edge. Do not rebuild or switch OAuth configuration between browsers; that would no longer prove one portable package.

Reloading the Google editor tab after reloading the extension avoids retaining an older content-script generation.

## Controlled live verification

Use disposable native and Drive-hosted Office fixtures containing non-sensitive data. Live verification is separate from deterministic mocks; do not claim Chrome, Comet, or Edge support until each browser completes this checklist with the same production artifact.

1. Build once with `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID`. Preserve that `.output/chrome-mv3` artifact and load the same bytes into Chrome, Comet, and Edge. Build with `WXT_SHEETS_READER=true`, and save a provider key in Settings (or rely on on-device translation).
2. Open a native Google Sheet allocated to at least 300 rows. On sheet A, keep the last source value near the top while including text, `0`, `false`, a formula with a textual displayed result, a formula such as `=""`, internal blank rows/columns, and formatting-only cells below/right of the content. On sheet B, place source values on both sides of a fully blank 100-row band. Keep a copy of representative source values/formulas.
3. While signed in to Readlace, click its toolbar icon on the supported spreadsheet editor. Confirm Reader opens directly without a popup or provider request. When signed out, confirm the login popup opens. Ordinary websites retain the popup. A missing Side Panel API keeps the existing popup/fallback flow.
4. Choose **Connect Google Workspace** and complete account selection/consent with an allowed test user. Connection must start only from this explicit action. Confirm the connection state separately from the current source/loading state.
5. Confirm discovery reads only the active sheet, reports its column and conditional row phases, and paints only after fixing `A1:lastUsedCell`. Verify `0`, `false`, and formulas count; formatting-only/blank-merge tails do not; internal blank/hidden rows and columns retain their absolute positions. Confirm the grid ends at the last used row/column despite the larger allocated dimensions. Do not record the discovered values.
6. Resize the browser Side Panel with its divider. Confirm Reader fills the available width, columns remain `1px..420px` with a `100px` fallback, long/newline text wraps without ellipsis, and horizontal scrolling preserves grid state. Record each browser separately rather than assuming parity.
7. Confirm the popup's **Translate** request continues automatically after loading, without a second click. Only the viewport plus one viewport ahead is scheduled; accepted translations replace source text, **Original** performs no provider request, and approaching the final 20 loaded rows requests one bounded 100-row-or-shorter page. Confirm trailing allocated rows cannot be scrolled into or loaded, an internal empty logical page may still be read, and an empty viewport sends no provider request. Open Reader directly separately to verify zero provider work until **Translate**. Scroll far enough to exercise resident-page eviction/reload without changing A1 identity or resending accepted translations.
8. If discovery pauses after rate limiting, timeout, or temporary service failure, choose **Continue discovery** and confirm it resumes from completed chunks. A response that exceeds 2 MiB must split into bounded row/column subranges; it must not bypass the ceiling.
9. Confirm **Worksheet | Translate to** remains inline at a 320px Side Panel width and an expanded width, with no page-level horizontal overflow. Verify the **Translate | Stop** slots do not move across idle/loading/translating/watching states; loading appears only in the primary button, presentation controls stay disabled until a result exists, and no completion count appears visually below the actions.
10. Confirm Vietnamese is the Reader default with no saved target; select Japanese and verify it survives Refresh, file/adapter changes, and Reader reopen. In an idle Reader, select sheet B from Reader's dropdown and confirm B loads with zero provider requests while Google's editor remains on sheet A. Start translation, select sheet C in Reader, and confirm one continuation after C is ready. Then change the browser/editor worksheet and confirm Reader retains its own worksheet, grid and settings with zero discovery/provider requests. A second click attempt on disabled **Translation on** must make zero duplicate request, cause no React #185/console error, and leave presentation/Stop usable. Add source content beyond the current bound, then use **Refresh** and confirm Reader recomputes `A1:lastUsedCell` from the current source.
11. Change the same browser tab from native Sheets to a Drive-hosted Office file. Confirm the old grid is retired, metadata identifies the fresh source, and Reader waits for Translate before value/media/provider work. Navigate back to a Drive list/folder or an unrelated tab and confirm the panel hides and stale work cannot commit. Returning must not auto-open or translate. Compare the source values, formulas, formatting, and undo history with the pre-check copy. Reader must have made no Google write request and no editor mutation.
12. Repeat with a native Google Doc containing root/child/grandchild tabs, paragraphs, a table with nested table content, an equation, and another unsupported inline object. Confirm Docs retains the card reader, initially loads only the active URL tab, and switches tabs only through the Reader control. In the network request, confirm `documents.get` uses `includeTabsContent=true` plus the fixed narrow fields mask for `documentId`, the supported three-level tab topology/properties, paragraph/unsupported content and table cells; no unmasked Docs GET is allowed.
13. Open a disposable Drive-hosted `.xlsm`/`.xlsx` in Google Sheets Office mode. Confirm validated Drive metadata identifies the Office source, Reader changes to **Google Drive Spreadsheet Reader** in the common panel without a local picker, and the latest saved workbook appears with the common controls and Reader's own worksheet selector. Switch worksheets in Reader before translation and confirm zero provider request; after translation is active, switch again and confirm one continuation. Confirm no workbook bytes, metadata, VBA, or unseen cells reach the provider. Make an unsaved editor change and confirm the UI makes no claim that it is included; save it, choose **Refresh**, and verify the new saved snapshot. Confirm there is no conversion, edit, export, or macro execution.
14. Choose **Disconnect Google** after a source/worksheet change and confirm it still stops active work, clears the Reader view and Google session token, and leaves the Readlace managed session signed in. The button is disabled only while disconnecting. Reconnect, restart only the extension service worker, and confirm a valid `storage.session` token restores within the same browser session. Then restart the browser or let the token expire and confirm Reader may require explicit reconnect.
15. Repeat steps 2–14 in Chrome, Comet, and Edge using the same saved artifact, real re-consent, enabled Drive API, and the disposable Office fixture. A pass in one browser does not prove another browser.

The live run must record browser/version, installed extension ID, OAuth project/client configuration boundary, fixture types, observed side-panel or tab fallback, API/provider outcomes, and before/after no-write evidence. Do not record access tokens, headers, source text, translations, or provider payloads.

## Fixed limits and errors

| Boundary                        |                                            Fixed value |
| ------------------------------- | -----------------------------------------------------: |
| Allocated Sheets dimensions     |                         Discovery search ceilings only |
| Sheets discovery chunk          |           32–512 columns, right to left, one in flight |
| Conditional row discovery chunk |   100 rows, bottom-up, doubling empties, one in flight |
| Effective Sheets grid           |                                 `A1:lastUsedCell` only |
| Sheets logical page             |                                               100 rows |
| Next-page threshold             |                                   final 20 loaded rows |
| Google API response             |                                        2,097,152 bytes |
| Resident populated records      |                                                 10,000 |
| Resident source text            |                                   256,000 UTF-16 units |
| Sheets column width             | `clamp(1px, API pixelSize or 100px, 420px)` per column |
| Translation window              |                       viewport plus one viewport ahead |
| Translation record              |                                     4,000 UTF-16 units |
| Translation message             |           128 records and 8,000 aggregate UTF-16 units |
| Google request timeout          |                                             10 seconds |
| Drive Office file               |                                                 20 MiB |
| Drive Office chunk              |                                        256 KiB decoded |
| Drive Office download timeout   |                                             30 seconds |
| Translation adapter concurrency |                                 2 per existing adapter |
| Local file                      |                                                 20 MiB |
| Local workbook sheets           |                                                     50 |
| Local selected sheet dimensions |                          100,000 rows × 16,384 columns |
| Local populated records         |                                                 10,000 |
| Local source text               |                                   256,000 UTF-16 units |
| Local parse timeout             |                                             15 seconds |

Reader exposes these terminal categories rather than silently changing behavior:

| Code                         | Operator/user action                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-configured`             | Rebuild with `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID`. Remove the unsupported legacy `WXT_GOOGLE_WORKSPACE_CLIENT_ID`.                                                                                    |
| `unsupported-browser`        | Use a supported desktop Chromium browser that exposes trusted `storage.session` (and, after Connect grants `identity`, `identity.launchWebAuthFlow`/`identity.getRedirectURL`).                       |
| `unsupported-url`            | Open an exact native Google Sheet or Doc editor route.                                                                                                                                                |
| `unsupported-file-type`      | Drive Office mode accepts only metadata-approved `.xlsx`/`.xlsm`; Local Reader additionally accepts `.csv`.                                                                                           |
| `google-auth-required`       | Choose **Connect Google Workspace** again. A `401` evicts the cached token once and never triggers surprise consent.                                                                                  |
| `google-access-denied`       | Check consent status, test-user membership, organization policy, and file access.                                                                                                                     |
| `google-oauth-configuration` | Check the Web application client ID and exact authorized redirect URI.                                                                                                                                |
| `google-oauth-response`      | Retry **Connect**; Google returned a malformed, duplicate, mismatched-state, or unexpected redirect response.                                                                                         |
| `google-oauth-scope`         | Reconnect and grant exactly `spreadsheets.readonly`.                                                                                                                                                  |
| `google-oauth-expired`       | Choose **Connect Google Workspace** again; the token is expired or its lifetime is invalid.                                                                                                           |
| `google-oauth-network`       | Retry **Connect** after browser/network recovery.                                                                                                                                                     |
| `google-oauth-failed`        | Retry **Connect**; if it persists, inspect browser identity/session capability without recording token data.                                                                                          |
| `google-permission-denied`   | The optional Google permissions were declined at **Connect**. Choose **Connect Google Workspace** again and allow access.                                                                             |
| `sheets-reader-unavailable`  | The build flag `WXT_SHEETS_READER` is off (default). Download the Sheet as `.xlsx` and use **Open local spreadsheet**.                                                                                |
| `office-download-required`   | A Drive-stored Office workbook needs a Drive scope that is not requested at launch. Download it and use **Open local spreadsheet**.                                                                   |
| `source-tab-changed`         | Reader normally recovers automatically. If this terminal protocol error remains, keep the intended source active and choose **Refresh**.                                                              |
| `response-too-large`         | Reader splits discovery/page ranges by rows and then columns; row discovery processes the lower split first. If one cell still exceeds 2 MiB, reduce that source cell; the ceiling is never bypassed. |
| `content-too-large`          | Reduce the Google logical page or local selected sheet below its populated-record/source-text limits; no provider dispatch occurred.                                                                  |
| `rate-limited`               | Discovery pauses with its cursor. Wait, then choose **Continue discovery**; Reader does not silently poll or restart completed chunks.                                                                |
| `temporarily-unavailable`    | After Google/network recovery, choose **Continue discovery** for a paused scan or **Refresh** for another failed phase.                                                                               |
| `invalid-request`            | Reload Reader and the source tab; the trusted message/source binding failed.                                                                                                                          |
| `auth-required`              | Retry; the work was stopped by a newer one.                                                                                                                                                           |
| `auth-unavailable`           | Retry.                                                                                                                                                                                                |
| `download-not-allowed`       | Ask the file owner or Workspace administrator to permit downloads; Reader does not bypass this Drive capability.                                                                                      |
| `file-too-large`             | Use a local or Drive Office file no larger than 20 MiB.                                                                                                                                               |
| `download-timeout`           | Choose **Refresh** after network recovery; Drive Office download is aborted after 30 seconds.                                                                                                         |
| `invalid-response`           | Retry **Refresh**; malformed metadata, length mismatch, invalid/partial stream, or protocol mismatch is discarded before parsing/provider work.                                                       |
| `too-many-sheets`            | Reduce a local workbook to no more than 50 worksheets.                                                                                                                                                |
| `dimensions-too-large`       | Reduce the selected local worksheet to no more than 100,000 rows and 16,384 columns.                                                                                                                  |
| `encrypted-workbook`         | Open an unencrypted copy; password-protected/encrypted workbooks are not parsed.                                                                                                                      |
| `invalid-workbook`           | Choose a valid supported local spreadsheet.                                                                                                                                                           |
| Local parse timeout          | Choose a smaller workbook; the parser Worker is terminated after 15 seconds.                                                                                                                          |

## Proof boundary

Unit, parser, manifest, mocked-background, component, and deterministic browser tests can prove routing, bounded two-axis Google discovery/splitting, mocked Sheets `400` to fixed Drive metadata/media download, bounded Office streaming, local/Drive CSV/XLSX/XLSM normalization, macro-disabled parsing, worksheet selection, visible-text-only provider payloads, negative download handling, source-value boundary semantics, absolute row/column order, viewport scheduling, grid rendering, plain-text/no-write behavior, stale-result rejection, and regression safety. They cannot prove real Google consent/re-consent, organization policy, Drive API access to a real file, installed-browser identity or Side Panel behavior, live provider success, or exact Excel rendering.

Until the controlled live checklist is completed with the real Web application client, exact redirect, Drive API, three-scope re-consent, and disposable native/Office fixtures, report Chrome, Comet, and Edge separately as **Blocked/Not run**, not Passed. Current deterministic proof does not establish live OAuth/API or Drive Office success in any browser. Keep live evidence separate from deterministic results.

### Reader source ownership proof boundary (2026-10-01)

The focused built-extension suite uses temporary headed fixture Chromium with real `Extensions.triggerAction`, `action.getPopup`, and `sidePanel.getOptions`, plus blocked external networking and deterministic Google/backend responses. It proves actual global/window-scoped toolbar opening, same-window supported-tab surface reuse in an awaiting-Translate state with zero value/provider calls, explicit close/no automatic return, two-window OPEN/close isolation, same-tab file classification, delayed Office metadata with no duplicate media work, empty-state settlement, dropdown ownership/settings, stale-result rejection, and 320/480/1000px skeleton/action geometry. Each toolbar fixture records the actual browser through `Browser.getVersion`; only that temporary fixture Chromium has observed API proof. It does not establish real Google consent/file access, actual Comet/Edge behavior, or readable bytes for arbitrary browser CSV/local-file URLs. Installed Chrome/Comet/Edge with the configured Google account and authorized real workbook remain Not run for this change; do not label this a cross-browser release pass.

Affected ADR 0004 feedback commands: `pnpm exec playwright test tests/e2e/workspace-reader.spec.ts tests/e2e/local-spreadsheet-reader.spec.ts --grep "reader source ownership|reader toolbar routing|reader loading states"` and the plan's focused Reader/provider-cancellation unit checks. No content-page ellipsis, provider-chain, native Translator, or web-flow mutation is part of this scope; live Asahi/Wikipedia/Yahoo and authenticated provider/native capability evidence remain outside these deterministic Reader results.

### Window-scoped panel lifecycle

The shared panel opens through a user gesture with `sidePanel.open({windowId})`, while all data and requests remain bound to a validated source tab/file. Supported tab A → supported tab B in the same window keeps the panel visible and identifies B in an awaiting-Translate state. Only explicit Translate authorizes its value/media/provider work. Drive lists/folders and unrelated tabs close the panel for that window; returning never opens it automatically. Window B toolbar events cannot retarget a Reader in window A. The direct extension-tab fallback retains its explicit bound-source lifecycle.

Chrome's [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) documents that tab-specific panels automatically return after switching back to their tab, while global `open({windowId})` and `close({windowId})` control the window surface. `close` is available from Chrome 141; implementations must feature-detect it. A browser without this method uses the global disable/prepare fallback, which can affect other windows; this is a compatibility limit requiring observed browser-specific testing, not equivalent multi-window proof.
