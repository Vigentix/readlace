# 0004 — Layout ellipsis

## Status

Accepted — reconstructed 2026-10-13 from docs/lessons.md, CONTEXT.md and referencing ADRs; original text was never committed.

This reconstruction was written after ADR 0014 (backend-routed stages) and updated for ADR 0020 (the user's own key, local provider stage, no backend). The original decision date is unknown; the earliest dated evidence is the 2026-08-20 and 2026-08-21 regressions recorded in `docs/lessons.md`. Where this text and `docs/lessons.md` disagree, `docs/lessons.md` holds the more recent evidence and this ADR should be revised to match it.

## Context

Translated text is usually a different length from its Japanese, English or Vietnamese source. Writing it into the page unchanged can grow controls, wrap navigation onto a second row, push headers, or overflow cells. Truncating it hides the translation. README product goal: protect layout integrity by avoiding overflow, clipping and obscured content, and use tooltips when text must be truncated.

The 2026-08-20 regressions had three interacting root causes:

- layout fallback restored the source text after the provider succeeded;
- the piece was still marked complete;
- global constraint revalidation let one stale record reject unrelated translations.

Later 2026-08-21 regressions on stretched controls, `truncate` labels (office-sheets-man.nativeai.io), a 306-row sales table and Asahi (asahi.com/ajw) navigation shared one root cause. Capacity was taken from something other than used geometry: tag lists, hostnames, the element's own clip, or measurements that ignored descendant chrome.

The layout module is `lib/translate/layout-ellipsis.ts` with its tests in `lib/translate/layout-ellipsis.test.ts`. The extension-owned wrapper is `<tryhand-ellipsis class="tryhand-ellipsis">`, styled in `assets/content.css`: `single-line` uses `white-space: nowrap` + `text-overflow: ellipsis`, and `multi-line` uses `-webkit-line-clamp: var(--tryhand-lines)`. The baseline marker is `tryhand-baseline-marker`.

## Linked Artifacts

| Artifact         | Path                                                                                                                                | Notes                                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lessons          | `docs/lessons.md`                                                                                                                   | Primary source: "Translation success must survive layout handling", "Used geometry is the only capacity discriminator", "Clip boundaries and wrapper styling follow used geometry too", "Batch the pipeline", "Capacity ends where descendant chrome begins"; each names this ADR as the governing policy |
| Glossary         | `CONTEXT.md`                                                                                                                        | Translation run, Translation path, Saved translations, Partial, Translated, Translation engine                                                                                                                                                                                                            |
| Engine routing   | `docs/decisions/0014-server-side-engine-routing.md`                                                                                 | Backend-routed stage and Free on-device path. The layout module and `content.css` are off-limits to engine and on-device work. Its review trigger uses this ADR's Asahi/Wikipedia/Yahoo samples                                                                                                           |
| Plans            | ADR 0011 (private record), superseded by ADR 0020                                                                                   | Free/trial/Pro paths that the proof contract must cover                                                                                                                                                                                                                                                   |
| Agent rule       | `AGENTS.md`                                                                                                                         | Read this ADR and run its proof contract before layout or translation-lifecycle changes                                                                                                                                                                                                                   |
| PRD              | `.scratch/commercial-launch/spec.md`                                                                                                | Requires the ADR 0004 proof contract for layout and lifecycle changes                                                                                                                                                                                                                                     |
| Open proof items | `.scratch/commercial-launch/issues/05-server-side-engine-routing.md`, `.scratch/commercial-launch/issues/06-free-on-device-path.md` | Headed Asahi/Wikipedia/Yahoo and live provider/native evidence still to be recorded in the Vigentix Chrome profile                                                                                                                                                                                        |
| Implementation   | `lib/translate/layout-ellipsis.ts`, `lib/translate/layout-ellipsis.test.ts`, `assets/content.css`                                   | Off-limits outside a layout ADR revision                                                                                                                                                                                                                                                                  |
| Proof suite      | `tests/e2e/layout-ellipsis.spec.ts`                                                                                                 | Deterministic, native-capability, live-provider and live-site tests                                                                                                                                                                                                                                       |
| Package scan     | `scripts/scan-release-secrets.mjs`                                                                                                  | Built-artifact secret scan (`pnpm scan:release-secrets`, `pnpm scan:release-secrets:store`)                                                                                                                                                                                                               |

## Options

The original options table was not committed. The options below are the alternatives the lessons record as tried and rejected.

| Option                                                                                                    | Description                                                         | Outcome                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Restore source on layout failure                                                                          | Fall back to the exact source when the translated text does not fit | Rejected (2026-08-20): it discards a successful provider result while the piece is still marked complete |
| Global constraint revalidation                                                                            | Revalidate every stored constraint after each batch                 | Rejected (2026-08-20): one stale record could reject unrelated translations                              |
| Tag/hostname capacity gates                                                                               | Cap `CONTROL_TAGS` or specific hosts at source glyph width          | Rejected (2026-08-21): caused false ellipsis on stretched icon+text controls                             |
| Grow shrink-to-fit controls into free row space                                                           | Let controls widen to fit the translation                           | Implemented, demoed and rejected by the user as layout shift                                             |
| Force navigation items to one line                                                                        | Single-line all nav/menu items                                      | Rejected (2026-08-21): items whose source renders two lines failed validation into raw multi-line towers |
| **Classify by used geometry; item-owned ellipsis/clamp; never source-roll back a successful translation** | See Decision                                                        | Accepted                                                                                                 |

## Decision

### Translation success survives layout

- A successful provider result for an eligible connected Text record stays translated. The exact source is used only for explicit restore (**Show original**) or for cancellation before application, never as a layout fallback. Unsupported wrapper cases keep the raw translation.
- One exception: a result equal to the source plus trailing punctuation only (for example `NAME:`) is not a translation, and the exact source is applied.
- A piece is complete only after every successful nonempty result remains installed. Failed, empty, detached or stale work stays incomplete.

### Classification before mutation

- **Mixed-inline flow** (a sentence with inline markup) stays raw and readable, so a sentence with markup is never frozen chunk by chunk.
- **Bounded and sole-text single-line** content shows the full raw translation when it fits. Otherwise it uses an item-owned `single-line` wrapper that ellipsizes inside the captured footprint. The wrapper's `title` carries the full translation only when the text actually overflows; an unwrapped or fitting label gains no title.
- **Bounded and sole-text multi-line** content keeps its captured visible footprint with a `multi-line` clamp to its captured line count. The captured line count is the footprint. Fragmented Range rects are clustered by half the fragment height, not a fixed 0.5px.
- Sole-text flow is captured too (user decision): single-line flow ellipsizes, and multi-line flow clamps to its captured line count.

### Capacity belongs to the item

- Used geometry is the only discriminator. Do not use `CONTROL_TAGS` or a hostname as a capacity gate.
- Dedicated remaining capacity is the owner's content interval after padding, border, icon, gap, measurable pseudo-elements and visible siblings. When a larger dedicated owner is proven, capacity is never the source glyph width.
- Shared inline or navigation rows without a dedicated owner keep source capacity only and never borrow sibling or row-wide width.
- Capacity ends where descendant chrome begins. Subtract the end-side padding, border and margin of elements between the node and the measured ancestor. Count a border only when its style actually renders.
- A clip whose used width is content-driven (shrink-to-fit context, not a width comparison alone) moves with the content, so the capacity walk continues to the real owner above it.
- A content-hugging ancestor is not dedicated capacity. Integer `clientWidth` rounding must not cumulatively shift peers, or let shorter text shrink a stretched block in an intrinsic owner.
- A captured `single-line` shrink-to-fit host protects its original used border-box. Overflow ellipsizes inside that footprint and never expands the host, action group or header. Controls freeze at their original used border-box. Growth needs a revision of this ADR.
- The single-line wrapper uses `block-size: auto` and `text-align: start`. It absorbs adjacent whitespace-only Text siblings and releases every child on unwrap (`releaseLayoutWrapper`), preserving node identity and order.
- Validate and repair only the current ownership group, with at most one source-width constrained retry. One record cannot poison another. Keep the 1px proof threshold.

### Batching and refresh

- Apply each response batch in chunks: reads (capture), one write pass, one read validation pass, then repairs for the failing subset. Nothing is awaited inside a chunk, so a frame never paints unrepaired raw text.
- Drift caused by the batch itself is absorbed by `rebaselineLayoutConstraint`, a read-only re-anchor of every stored rect. The host's own footprint must survive the re-anchor: height always, and width too for multi-line. Otherwise the record goes to repair.
- Restore every still-failing source before re-capturing any of them.
- The 300ms refresh validates under an 8ms budget with a rotating cursor. The baseline marker is sampled lazily at wrapper install, in the captured host frame.
- A visible source can become hidden while awaiting a provider. Do not capture a collapsed layout. Retain successful slots in run-owned pending results and revalidate run, account and source on reveal. Then apply and cache them with no resend or fallback.

### Relationship to translation engines (current, after ADR 0020)

- Layout protection applies to every engine's result: the local provider stage (the user's own OpenAI key, up to three attempts per record, no Google fallback; ADR 0020) and the browser-native Translator. Without a key, the per-record on-device stage uses the same layout protection.
- Provider, cache, lifecycle, collector, coverage, engine-routing and on-device throughput work must not modify `lib/translate/layout-ellipsis.ts`, `lib/translate/layout-ellipsis.test.ts` or `assets/content.css`. It must not weaken raw, ellipsis, clamp, title, geometry or restore proof outcomes either.
- Layout changes need a separate revision of this ADR and explicit user approval.
- No site rule, host mutation, observer, listener, timer, provider endpoint, dependency or eager whole-document scan is added for layout.

### Proof contract

A layout or translation-lifecycle change is complete only with all of the following. Deterministic evidence cannot substitute for external provider or native success. Live unavailability is a recorded proof boundary, not a pass and not a product failure.

1. **Deterministic per-stage evidence**: order, count, cache and provenance for the provider stage (up to 3 OpenAI attempts) → browser-native → unresolved chain on the `provider` path (a saved key), and for cache → browser-native → unresolved on the `native` path (no key). It also covers exact restore and the existing raw/ellipsis/clamp/title/geometry outcomes.
2. **Package proof**: the built extension artifact (`.output/chrome-mv3`, or `.output/store/` for the Store build) loads, keeps its pinned identity, and contains no provider key or secret. The phrase "package proof" comes from `docs/lessons.md`. This reconstruction maps it to the build/identity/no-provider-key tests and the release secret scan listed below.
3. **Browser-native capability attempt**: one recorded attempt to prepare and use the on-device Translator in an installed Chrome 138+ desktop runtime. Installed-runtime evidence governs every native-success claim.
4. **Live provider evidence**: one bounded, redacted run with a real OpenAI key saved in Settings, recording OpenAI request counts and provenance. A missing key or provider outage is recorded as the boundary. (The `@provider-fallback-live` spec still targets the retired backend and must be rewritten for this item; until then, record the attempt by hand.)
5. **Existing performance gates**: warm accepted records and scroll-back make zero provider calls. Retries and partial generations request exactly the unresolved cache misses. No generation exceeds the per-record ceiling (`3 OpenAI` inside a completed stage plus `1 browser-native`, or `1 browser-native` without a key). The provider-stage adapter stays at concurrency `2`.
6. **Headed Asahi, Wikipedia and Yahoo attempts**: recorded headed attempts on `https://www.asahi.com/ajw/`, `https://en.wikipedia.org/wiki/Main_Page` (scroll) and `https://www.yahoo.co.jp/`. Each translates and restores through the top frame, with no page errors and no leftover `tryhand-ellipsis`/`tryhand-baseline-marker` residue after restore. When the Free path changed, the attempts also cover it, with a readability judgement of on-device quality (ADR 0014 review trigger).

## How to run the proof

Constraint: live and headed runs happen in the user's existing **Vigentix Chrome profile**. Agents do not launch browsers. They prepare the build and commands, and the user runs the live steps and records the outcome, including "unavailable" boundaries, in the relevant `.scratch/<feature>/issues/` file.

The Playwright harness in `tests/e2e/layout-ellipsis.spec.ts` always launches a persistent context on a fresh temporary profile (`mkdtemp(tmpdir(), "tryhand-layout-")`). It has no option to attach to an existing profile. Its live tests are therefore harness evidence. The headed site attempts in item 6 are recorded from the Vigentix profile with the built unpacked extension loaded.

Build and package (agent or user):

```powershell
pnpm compile; pnpm lint; pnpm test:run          # includes lib/translate/layout-ellipsis.test.ts
$env:WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID = '123456789012-readlacereader-web.apps.googleusercontent.com'
$env:WXT_SHEETS_READER = 'true'                   # e2e builds include the Reader
pnpm build                                        # .output/chrome-mv3
pnpm scan:release-secrets                         # package proof: no provider key or secret in the artifact
```

Deterministic e2e (user, since it launches Chromium):

```powershell
pnpm exec playwright test tests/e2e/layout-ellipsis.spec.ts --grep "@deterministic|@indexeddb-storage|@stable-auth-identity|@translation-first|@provider-integrity|@openai-performance|@record-cache-performance|@native-recovery"
```

Environment flags the spec reads:

| Flag                                                                                             | Effect                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAYWRIGHT_EXTENSION_PATH`                                                                      | Built extension directory (default `.output/chrome-mv3`)                                                                                                                                                                                                                                                                                     |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`                                                            | Use an installed Chrome/Chromium binary (the test never downloads browsers)                                                                                                                                                                                                                                                                  |
| `PLAYWRIGHT_HEADLESS=0`                                                                          | Run headed                                                                                                                                                                                                                                                                                                                                   |
| `RUN_NATIVE_TRANSLATOR_PROBE=1`                                                                  | Enables `@native-capability` (headed, installed executable, 420s timeout). Without it the worker's `Translator` is removed so no model download starts                                                                                                                                                                                       |
| `RUN_LIVE_PROVIDER_FALLBACK=1`                                                                   | Enables `@provider-fallback-live`. Loads `.env.test` when present and needs a real `WXT_BACKEND_URL` (not `https://api.example.test`) and `LIVE_TEST_BACKEND_REFRESH_TOKEN`. It attaches `provider-fallback-live-redacted.json` with stage, engine and provenance counts and no text. Missing inputs attach an `unavailable` record and skip |
| `RUN_LIVE_LAYOUT_SMOKE=1`                                                                        | Enables the `@live` Asahi AJW, Wikipedia scroll and Yahoo! JAPAN tests. They load the real sites with the **deterministic** backend, so they prove live-site DOM/layout, not provider success. External markup changes are skips, not product evidence                                                                                       |
| `RUN_LIVE_NAV_REALISTIC_LABELS=1`                                                                | Uses realistic Vietnamese navigation labels for the Asahi live case                                                                                                                                                                                                                                                                          |
| `RUN_LIVE_OPENAI_BENCHMARK=1`, `OPENAI_BENCHMARK_BUDGET_USD`, `OPENAI_BENCHMARK_PRIOR_SPEND_USD` | Opt-in `@openai-live-benchmark`. Noted in `.scratch/commercial-launch/issues/05-server-side-engine-routing.md` as needing rework now that calls go through the backend                                                                                                                                                                       |

Live evidence (user):

```powershell
# Item 3: native capability attempt on installed Chrome 138+
$env:RUN_NATIVE_TRANSLATOR_PROBE = '1'
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '<path to installed Chrome>'
pnpm exec playwright test tests/e2e/layout-ellipsis.spec.ts --grep "@native-capability"

# Item 4: live OpenAI with your own key, recorded by hand in the profile below
# (the @provider-fallback-live spec still targets the retired backend).

# Item 6 harness complement: live-site layout with the deterministic provider stub
$env:RUN_LIVE_LAYOUT_SMOKE = '1'; $env:PLAYWRIGHT_HEADLESS = '0'
pnpm exec playwright test tests/e2e/layout-ellipsis.spec.ts --grep "@live"
```

For item 6 in the Vigentix Chrome profile, load `.output/chrome-mv3` with **Load unpacked**. Run it once with an OpenAI key saved in Settings (the `provider` path) and once without a key (the `native` path, when on-device translation changed). Then on Asahi AJW, Wikipedia Main Page (scroll down and back) and Yahoo! JAPAN:

1. Click **Translate**.
2. Check that the navigation stays on its captured row, that overflowing single-line labels ellipsize with a full-translation tooltip, and that multi-line blocks keep their footprint.
3. Click **Show original** and check the exact restore.

Record the attempt, browser version, path (provider/native) and outcome, or the unavailability reason.

## Consequences

Positive:

- Successful translations are never discarded for layout reasons, and one bad record cannot reject its neighbours.
- Navigation, controls and headers keep their original footprint. Truncated text stays reachable through the tooltip.
- Engine changes (ADR 0014) and on-device throughput work leave layout safety unchanged, because the layout module is off-limits to them.

Trade-offs:

- Single-line items can show an ellipsis where row space was free. Growth was rejected as layout shift.
- Mixed-inline flow stays raw and can reflow its paragraph.
- Completion needs live, headed evidence that agents cannot produce. Until the user records it, the proof is incomplete and is reported as such, never as passed.

## Review Trigger

Revise this ADR, with explicit user approval, before any change to `lib/translate/layout-ellipsis.ts`, `lib/translate/layout-ellipsis.test.ts` or `assets/content.css`. Also revise it before reintroducing control growth, or when a site regression shows a capacity rule keyed on something other than used geometry. If on-device quality on the Asahi, Wikipedia and Yahoo samples is judged unreadable, follow the ADR 0014 review trigger.
