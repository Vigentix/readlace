# Readlace — Web Page Translation

This context defines the user-facing language for translating a web page, reading a translated native Google Sheet, or opening a local spreadsheet in read-only Reader UI while preserving original content and per-site preferences.

## Current support and eligibility (2026-10-03)

Explicit page translation bypasses `translate="no"` and `.notranslate` at every readable-text/attribute/title level. Editable values and contenteditable/editor, script/style/code/math content remain excluded. Page metadata that discourages browser translation does not block Readlace.

Google Docs is temporarily unsupported. Its editor is recognized to show the unavailable state and prevent misleading DOM/editor-chrome translation; no Docs Reader read/translation operation is allowed. The Docs-specific implementation descriptions below are reserved, inactive behavior. The existing Google OAuth scope set is retained for token/build compatibility during this temporary suspension; it does not imply Docs support.

Reader partial continuation may translate newly visible eligible cells while preserving accepted results. Unresolved/oversized cells do not block untouched cells elsewhere. Each Reader owns its selected worksheet/discovery/content independently. Timeout messages distinguish waiting from cancellation, and a still-running request retains its owner slot.

Local/Drive workbook parsing additionally limits aggregate expanded ZIP content to 20 MiB and 4,096 members before SheetJS parsing. Unsupported ZIP64/multidisk/encrypted/inconsistent archives fail explicitly. Frozen panes, RTL/gridlines, authoritative point-based row heights and shared/inline rich runs are preserved from saved OOXML where supported.

## Accounts (ADR 0020)

The open-source extension has no accounts, sign-in, plans, quota, billing or telemetry. Every feature is open to everyone, and the background answers status requests for one local user. The vocabulary of the earlier commercial build (managed accounts, Google sign-in, plans, trial, quota, subscriptions, product events, session verification) is not part of this context.

## Extension, Readers and identity

**Internal Chromium identity**:
The committed public manifest key fixes the Chrome/Chromium **Load unpacked** Extension ID at `imlhpiikjakgljngkdalbfgdpkniejdb`. It fixes identity only; it does not prove publisher trust or make arbitrary unpacked bytes safe. Each internal machine manually loads known local bytes for trusted development/staging use. A dev build may set `WXT_EXTENSION_PUBLIC_KEY` to the Store item's public key so its unpacked ID matches the published ID. The **Store build** (`pnpm build:store` / `pnpm zip:store`, output `.output/store/`) omits the manifest `key`; the Chrome Web Store assigns the published ID.

**Roadmap**:
The public list of capabilities that are not available yet: [`docs/roadmap.md`](docs/roadmap.md), mirrored by the landing page's roadmap section, with no dates. Only the Roadmap may mention more languages, Google Docs, PDF, Word/PowerPoint, glossaries or official Edge/Firefox support; every other public surface describes only what works today.
_Avoid_: feature list, coming features, timeline

**Persistent extension state**:
Generated Chromium and Firefox manifests disallow Incognito until a separately designed no-persist flow exists. Normal-profile state remains in extension-origin IndexedDB database `web-page-translation`, version `1`, store `kv`; content scripts never open it directly.

**Google Workspace access**:
Read-only resource authorization granted separately after the user chooses **Connect Google Workspace**. That click first requests the optional `identity` permission and optional `https://sheets.googleapis.com/*` host with `permissions.request` (ADR 0015); the manifest requires neither, so enabling Workspace never disables an installed extension. One Web application client in `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID` serves the same desktop Chrome/Comet/Edge package through `identity.launchWebAuthFlow`; the redirect derived by `identity.getRedirectURL("google-workspace")` is `https://imlhpiikjakgljngkdalbfgdpkniejdb.chromiumapp.org/google-workspace` for the committed extension identity; forks use their own OAuth client and redirect. The legacy `WXT_GOOGLE_WORKSPACE_CLIENT_ID` is rejected. Authorization uses exactly `spreadsheets.readonly` (ADR 0015; `documents.readonly` and restricted `drive.readonly` were removed), with no client secret, API key, browser sniffing, or native fallback. A session token for the former three-scope set is rejected and requires one reconnect. The versioned access token stays only in trusted `storage.session`, bound to client/extension/scopes/expiry and the local user, and can survive service-worker restart inside the same browser session. It is cleared on invalid/expired state, Google `401`, Disconnect, or configuration change; browser/extension lifecycle clears session storage, so browser restart or expiry may require reconnect. Google Workspace access is not a Readlace account (there is none) and never sends a Google token to local/sync/IndexedDB, logs, runtime messages, pages, or a translation provider.
_Avoid_: Readlace Google login, provider authorization

**Google Workspace Reader**:
The Chromium-only extension page `/reader.html` that reads the current validated native Google Sheet or Google Docs tab and shows plain-text translations without overlaying or changing the editor. The native Sheets Reader exists only in builds with `WXT_SHEETS_READER=true` (ADR 0020); the official build keeps it off until Google OAuth verification. Without it, a native Sheet keeps the popup, which shows "coming soon — File → Download → Microsoft Excel (.xlsx), then open it in Local Reader" with **Open local spreadsheet**; an open Reader shows the same notice. Docs keeps its unavailable state, and the Drive Office path below is disabled at launch (no Drive scope): the Sheets API refuses the Office file and Reader shows the same download guidance (ADR 0015). The same production artifact targets desktop Chrome, Comet and Edge, but support is claimed per browser only after live proof. It fills a browser-controlled, user-resizable window-scoped Side Panel, with an extension-tab fallback. Native Sheets and Drive/local workbooks share the inline **Worksheet | Translate to** row (there is no Provider control; the **Engine source** decides), stable **Translate | Stop** slots, presentation toggle and secondary actions. Reader owns worksheet selection independently of the bound editor gid: bootstrap validates file ownership, Refresh and recovery retain the Reader worksheet, and same-file browser worksheet changes leave Reader untouched with zero discovery/provider calls. The Reader-owned worksheet dropdown changes only Reader; idle selection only loads, while active selection continues visible translation when the selected grid is ready. Rapid source changes commit only the latest result. Only an active native Sheets `GRID` uses the Google spreadsheet grid: before first paint, bounded 32-column batches scan right-to-left and discard their active-sheet values after deriving the rightmost populated absolute column; they are never sent to a provider. The immutable A-through-last-used-column sequence preserves internal blank/hidden positions. Source/layout then loads in 100-row logical pages, requesting the next page once near the final 20 loaded rows and evicting distant pages to preserve the 10,000 resident populated-record and 256,000 resident-source-character limits. Docs keeps card records for the active tab from a fixed narrow `documents.get` response. A Drive-hosted `.xlsx`/`.xlsm` opened in Google Sheets Office mode instead enters `/reader.html?office=1&sourceTabId=<tab>`: the background re-derives the file ID, downloads the latest saved snapshot with fixed Drive metadata/media GETs, enforces 20 MiB/30 seconds, streams bounded chunks to Reader, and parses in the existing Worker. Reader owns worksheet selection; it does not mirror the active Google Office tab or promise unsaved editor state. Workbook bytes remain in extension memory and only visible textual cells are translated, through the **Translation path**, after explicit Translate. Drive conversion, macro execution/preservation, Picker, `drive.file`, OCR, write/export APIs and canvas fallback remain unsupported.
_Avoid_: Google editor overlay, translated spreadsheet copy, Google page translation

**Local Spreadsheet Reader**:
The Chromium extension page `/reader.html?local=1`, open to everyone (ADR 0020), opened through the popup action **Open local spreadsheet**, where the user explicitly picks one `.csv`, `.xlsx`, or `.xlsm` file or drops it anywhere on the page. A drop of another type, of several files or of a file over 20 MiB is refused with a message before any bytes are read, and leaves an open workbook in place. The action opens a normal extension tab and closes the popup only after the tab is created. It does not intercept or modify browser/Office viewers. Parsing runs inside a dedicated bounded Worker; source bytes remain local to that extension process and are never uploaded, persisted, logged, cached, or sent to a provider. Google OAuth and Google APIs are not involved. Translation follows the **Translation path**: only visible untranslated textual cells go to the provider with the user's key, or are translated on-device without one.

Local Spreadsheet Reader preserves worksheet order, absolute A1 positions/internal blanks, values, formulas with available cached display, merges, row/column sizes, hidden dimensions and best-effort basic styles. It does not calculate formulas or promise exact Excel rendering. Charts, images, pivots, conditional formatting and external-data refresh are excluded. `.xlsm` is read-only with `bookVBA: false`: VBA is never executed, exposed, preserved, written, downloaded or exported. Password-protected/encrypted workbooks fail explicitly; no local workbook is edited, saved or exported. Fixed limits are 20 MiB/file, 50 worksheets, 100,000 used rows, 16,384 columns, 10,000 populated records and 256,000 source UTF-16 units per selected worksheet, plus a 15-second parse timeout.
_Avoid_: Office viewer integration, uploaded workbook, editable workbook, macro support

**Reader selection**:
For Docs cards, explicit records checked inside Google Workspace Reader for **Translate selected**. In the Sheets grid, selection exposes accessible cell details with source and translation; it is not a provider-work selection. Neither mode inspects, moves, or claims the Google editor cursor or selection.
_Avoid_: Google selection, editor selection, selected cells in Google

**Reader translation**:
The Sheets-grid generation starts only after explicit **Translate**, a source-bound popup Translate intent, or an active Reader dropdown continuation, and schedules untranslated cells in the viewport plus one viewport ahead with one Reader message pending. `idle` shows **Translate**; `translating` shows its spinner and **Translating…**; `watching` shows disabled **Translation on**; `paused`, `partial`, and `error` expose **Resume translation**, **Retry unresolved**, and **Retry** respectively. **Stop** always occupies its slot and is enabled only during `translating`/`watching`. Completion counts are visually hidden announcements; only actionable partial/warning/error states remain visible. Same-file editor worksheet changes leave Reader selection and content unchanged with zero discovery/provider calls; active Reader dropdown changes continue after load. Direct Reader opening remains load-only; Stop, Clear view, Disconnect Google, teardown, settings changes, or new-file navigation stops continuation. Translation replaces source text visually; **Translation / Original** changes presentation without dispatching or clearing accepted results and stays disabled until a translation exists. Grid columns, merges and frozen panes follow the source; rows start at their source height and grow (never shrink) so every source and translated text is fully visible, using the larger of the two so **Translation / Original** never shifts the grid. Text keeps its source mode while it fits (**overflow** across empty neighbours up to the first blocker, **clip**, **wrap**); text that would be cut wraps instead, overflow text across its own corridor. Text is never ellipsized; selected-cell details expose the full translation. Docs retains explicit loaded/checked-card translation. Both follow the **Translation path**: on `provider`, the local provider stage with existing cache validation/namespaces and concurrency `2`; on `native`, saved translations and then one on-device attempt per text, saved to the chain cache as `browser-native`. There is no page run, client fallback loop, history or provider choice. One record is limited to 4,000 UTF-16 units; one message is limited to 128 records and 8,000 aggregate units. Results are bound to the Reader owner/source version, source tab, file/sheet/Docs-tab, grid generation, target, request and source hashes, so stale work cannot update Reader.
_Avoid_: page run, Reader fallback chain, live editor translation

## Language

**Provider settings**:
The user's translation provider configuration (ADR 0020): the active provider (OpenAI only today), its model and the user's own API key. A versioned record in extension-origin IndexedDB, read only by the background and changed only from the Settings page (`/options.html`). Every other surface sees a masked view (`sk-…abcd`), never the key.
_Avoid_: account, plan, subscription, hosted key, credentials store

**Engine source**:
Which engine a translation starts from: `byok-openai` while a provider key is saved and not rejected, otherwise `on-device`. A future hosted offer adds a source without changing the translation flow.
_Avoid_: plan, tier, provider choice per run

**UI locale**:
The language of the extension's own interface (popup, Reader pages, selection panel, Store name and description): Vietnamese or English. It is independent of the **Target language**, the **Page language** and the landing page language. Until the user chooses, a browser UI language starting with `vi` (`i18n.getUILanguage()`) gives Vietnamese and every other language English; the popup's **Language / Ngôn ngữ** switch (popup menu) stores an explicit choice under `uiLocale` in the extension IndexedDB `kv` store. Only the background reads or writes it (`UI_LOCALE_GET` from any extension context, `UI_LOCALE_SET` from extension pages only); a change is broadcast as `UI_LOCALE_CHANGED`, so the open popup and Reader pages switch at once, while the selection panel asks the background again on its next open. Messages live in typed catalogs (`lib/i18n`), English as the source of truth; JSON codes are mapped to messages at the UI edge, never the reverse. The Store name and description come from `public/_locales` (`default_locale: "en"`, plus `vi`).
_Avoid_: interface language setting, extension language, translation language, app locale

**Page language**:
Evidence about the language of the tab, resolved from the top-frame `html[lang]` plus `tabs.detectLanguage` and reused by nested frames. The popup shows the resolved label; only agreement on the same `en`, `vi`, or `ja` produces `autoSkipTarget`. Conflict, missing, invalid, or `und` evidence never produces an automatic skip. This evidence can skip **Always-translate** only and never blocks explicit **Translate**.
_Avoid_: source language, origin language, input language, detected source, Source

**Frame**:
One HTML document in the tab: the top page or a nested iframe. A translation run and Show original cover every injected frame, including frames that load later while the Always-translate preference remains enabled and skip does not apply.
_Avoid_: tab, window, nested page, embed

**Translation engine**:
The service that translates a record. In the open-source extension (ADR 0020) it is OpenAI, called directly from the background with the user's own API key and chosen model, retried at most three times per record inside one local translation stage, with no Google fallback; records it leaves unresolved go to the on-device stage. The hosted backend's OpenAI → Google Cloud chain is kept only for a future hosted offer. Engines are never shown as a provider choice per run.

**Translation path**:
Where a translation runs, chosen by the pure client selector `chooseTranslationPath(engine source, native availability)` (ADR 0020): `provider` (a saved, accepted provider key: the local provider stage, then the on-device recovery stage), `native` (no key, or OpenAI rejected the key: saved translations, then on-device per record) or `unavailable` (neither). The **Engine source** comes from the provider settings, not from a plan.
_Avoid_: translation provider, provider selection, Google-selected run, OpenAI-selected run, provider source, site provider, cache provider

**Provider source**:
The language route resolved independently for each eligible record. Japanese-script records use `ja`; otherwise a compatible trusted Page language hint is used, and ambiguous records use `auto`. The same route owns provider input, local validation, native recovery, and Saved translations identity; it is not the page-language label or one page-wide source.
_Avoid_: source language, locked source, detected source, page-wide source

**Target language**:
The single language selected for the current translation run: English, Vietnamese, or Japanese.
_Avoid_: output languages, multiple targets

**Selected text**:
A single nonempty range of readable page text captured in one Frame after the user completes a mouse or keyboard selection. It may cross inline nodes and rendered lines, but it excludes input, textarea, contenteditable/editor content, ranges that touch them, and cross-document or shadow-root selections.
_Avoid_: selected field value, editor selection, page source

**Selection translation**:
A user-triggered translation of Selected text shown as plain text in a floating Readlace panel. The lightweight manifest bootstrap and runtime controller share one eligibility reader, so blank, multi-range, editable and cross-root selections cannot trigger the heavy runtime or later become translatable through divergent checks. After the first eligible selection, the background injects only the fixed isolated-world React runtime into the sender `documentId`, falling back to the validated sender frame only where document targeting is unavailable. The runtime remains loaded for that document's lifetime after first use. The closed-shadow panel uses the shared compact Select component, portals its lists within the same ShadowRoot, and uses direct Lucide action/loading/error icons while the trigger keeps the Readlace brand icon. Its fixed pixel typography, controls and icons do not inherit a page's root font scale. A long result scrolls inside its labelled surface without chaining boundary wheel input to the page. The result surface expands/collapses over 180 ms, re-clamps inside the viewport, and disables motion for reduced-motion preference. Closing or repositioning the panel preserves a reopen icon and result while the Selected text remains eligible. Its target starts as English per document and may be English, Vietnamese, or Japanese. The panel has no provider control. Changing its target does not write the global Target language or Always-translate preference and cannot change a current or future Translation run. **Translate** snapshots the panel target into an explicit request that follows the **Translation path** (the provider with the user's key, otherwise saved translations and then on-device); a request carrying a provider is rejected, and later UI/global changes cannot retarget the pending request. Selection work does not join or cancel a Translation run. Firefox selection runtime requires Firefox 102 or later.
_Avoid_: partial page translation, selection run, inline replacement

**Translation run**:
A user-triggered or preference-triggered attempt to translate discovered eligible records in every frame in the tab from preserved original content. A new target restores the page before starting; same-target **Translate** from `partial` starts a new generation for the discovered active unresolved records only and keeps accepted DOM, Saved translations, and exact-restore ownership unchanged. Each eligible connected record follows exactly: valid OpenAI v10 or chain v1 cache → one local provider stage (on the `provider` **Translation path** only) → one browser-native attempt for a known supported non-target `ja|en|vi` route → unresolved. Inside the provider stage the background makes at most three OpenAI attempts with the user's key (500 ms and 1,500 ms delays or bounded `Retry-After` up to 30 seconds, retrying only failed or quality-missed records); there is no Google fallback. OpenAI 401/403 marks the key rejected and leaves the records for the browser-native stage; any other non-retryable provider error ends the run in error. Records the stage leaves unresolved go straight to native. `auto` and same-target routes skip native; unavailable, stalled, rejected, stale, or detached outcomes remain unresolved. Stages are sequential, accepted records never enter a later stage, and the per-record ceiling per generation is `3 OpenAI` plus `1 browser-native` on the `provider` path, and cache → `1 browser-native` → unresolved on the `native` path. Popup busy semantics cover the entire chain until terminal state. Explicit **Translate** always overrides Page language evidence. It is disabled while translating/preparing, when the selected target is already completely applied, or when the path is `unavailable`.
_Avoid_: translation session, batch job

**First visible translation**:
The first moment in a Translation run when an accepted translation is visibly retained on the page. It is not the provider's first token or first completed network response.
_Avoid_: time to first token, first response, loading feedback

**Viewport completion**:
The moment when a Translation run has settled every discovered eligible record in the current viewport and no provider work for that viewport remains. A fast Partial or error is not translation success and is evaluated separately from completion speed.
_Avoid_: full-page completion, whole-document completion, provider response time

**Always-translate preference**:
A setting stored for the registrable domain (eTLD+1), not the exact hostname, that remembers the target language without starting a translation run when checked. Sibling hosts under the same eTLD+1 share it (`www.yahoo.co.jp` and `news.yahoo.co.jp` share `yahoo.co.jp`; `www.example.com` and `example.com` share `example.com`). The first run requires Translate; later reload or document load auto-starts unless `autoSkipTarget` equals the preference target (Unknown still auto-translates). This automatic cost policy does not apply to explicit **Translate**.
_Avoid_: global auto-translate, cache setting

**Saved translations**:
Accepted results stored independently per normalized record and scoped by model or recovery chain, Provider source route, and Target language. Runs prefer a valid OpenAI v10 hit, then a valid chain v1 hit, before the provider stage. A provider result is written only to the OpenAI v10 namespace; a browser-native result only to the chain namespace with `p: "browser-native"`. Chain keys are exactly `translationCache:chain:v1:openai-google-native:<route>:<target>:<sha1(normalized-source)>`; values contain accepted text plus provenance `browser-native` (or `google`, written only by the hosted backend's Google fallback). Every hit is locally revalidated, and a chain entry is written only after its result remains accepted in connected current DOM. Chain entries never write into or impersonate the OpenAI namespace. The legacy client-selected Google namespace (`translationCache:google:`) is no longer read or written. Bulk reads and writes let cache hits and duplicate owners reuse accepted results without provider calls, regardless of DOM piece boundaries, page URL, record order, sibling failures, or run generation. Failures are never saved, and storage failure does not undo accepted DOM. Saved translations are independent from target-language and always-translate preferences.
_Avoid_: translation cache, browser cache, page preference

**Clear saved translations**:
The action that removes the OpenAI, OpenAI-chain and legacy Google saved-translation namespaces plus local aggregate translation diagnostics without changing settings/preferences or restoring the page.
_Avoid_: clear cache, delete cache

**Show original**:
The action that restores every frame in the tab to its preserved original content without starting a new translation run.
_Avoid_: toggle translation off, stop translation

**Partial**:
A terminal translation-run result in which accepted and discovered eligible unresolved records coexist after the run's bounded provider/native chain has finished. It never schedules those unresolved records by itself; same-target **Translate** starts one explicit unresolved-only generation.
_Avoid_: translated, retrying, resumed run

**Translated**:
The disabled Translate-button state when every currently discovered eligible record is complete for the selected applied target. It is discovery-relative under lazy viewport-plus-one-viewport eligibility: offscreen undiscovered content does not make the state Partial, and newly eligible work may temporarily change the popup to **Translating…**. Scroll-back never resends accepted records.
_Avoid_: whole-document scan complete, every offscreen record translated
