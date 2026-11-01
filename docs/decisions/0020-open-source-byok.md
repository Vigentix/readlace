# 0020 — Open-source extension with bring-your-own-key

## Status

Accepted (2026-10-31). Supersedes, for the extension, the commercial launch set: ADR 0010 (backend-owned provider keys), 0011 (plans, trial, quota), 0012 (public sign-in), 0013 (Polar billing), 0014 (server-side engine routing), 0016 (hosting) and 0017 (content-data commitment, replaced by a simpler one). ADR 0015 stays, except the Sheets flag source. The backend code is kept, frozen, for a possible hosted-key offer later.

## Context

Readlace was prepared as a paid product: a NestJS backend owning OpenAI and Google keys, managed and Google sign-in, a reverse trial, a hidden character quota and Polar subscriptions. None of it is in production: no Chrome Web Store listing, no Polar organization, no hosting.

The team (one developer plus Claude) now wants to launch Readlace first as an **open-source, completely free** extension. Users who want AI translation bring their own provider API key and pay the provider directly. Vigentix does not configure or pay for any system API key. A paid hosted-key offer may come later.

Facts from the code that shaped the decision:

- `shared/openai-completer.ts` takes `apiKey` and `fetchImpl` and has no backend dependency, so it can run in the extension background.
- The manifest already has `host_permissions: ["<all_urls>"]`, so the background can call any provider without CORS or new permissions.
- Content scripts already send translation work to the background by message; the background is the trusted broker. Google Workspace tokens already live in `storage.session` with `TRUSTED_CONTEXTS`.
- `chrome.storage.local` is readable by content scripts by default. Extension-origin IndexedDB (`lib/indexeddb-storage.ts`) is not.
- Prompt, strict JSON schema output, format guards and captured-response tests are tuned for `gpt-5-nano`.
- The repository mixes extension code with backend, billing, hosting, legal and security-scan material, and its history contains all of it.

## Linked Artifacts

| Artifact   | Path                                                                                                             | Notes                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Spec       | `.scratch/open-source-byok/spec.md`                                                                              | Implementation spec and order                  |
| Superseded | `docs/decisions/0010` … `0017`                                                                                   | Commercial launch set                          |
| Kept       | `docs/decisions/0004-layout-ellipsis.md`                                                                         | Layout proof contract still binds every engine |
| Code       | `shared/openai-completer.ts`, `lib/translation-path.ts`, `lib/indexeddb-storage.ts`, `entrypoints/background.ts` | Main touch points                              |

## Options

| Question             | Chosen                                                                                        | Rejected                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Extension calls the provider directly with the user's key; no backend in the translation path | Backend proxy receiving user keys (hosting cost, custody of third-party secrets)                                                   |
| Account              | No sign-in, no plans; every feature open to everyone                                          | Optional sign-in now (needs a running backend, no user value until hosted keys exist)                                              |
| Providers at launch  | OpenAI only; data model and UI already multi-provider                                         | OpenAI-compatible base URL at launch (unverified models break strict JSON output)                                                  |
| Key storage          | Extension-origin IndexedDB, read only by background and Settings                              | `storage.sync` (key leaves the machine); passphrase encryption (theater or bad UX)                                                 |
| Repository           | New public repo with clean history, nested in the private workspace                           | Publish the current repo (history leaks billing, hosting, legal); git submodule; private monorepo with subtree export              |
| License              | Apache-2.0 + DCO + trademark policy                                                           | GPL-3.0 (protection depends on enforcement Vigentix cannot afford; blocks a later closed build without CLA); MIT (no patent grant) |
| Telemetry            | None in code                                                                                  | Opt-in PostHog/Plausible (thin data, third party, policy work)                                                                     |
| Google Sheets Reader | Off at launch; OAuth verification after the Store ID exists                                   | Wait for verification before launch                                                                                                |
| Issue tracking       | GitHub Issues/Discussions for `readlace/`; `.scratch/` stays private                          | Everything on GitHub (exposes business plans)                                                                                      |
| Order                | Do BYOK and the commercial removal in the private repo, then publish a clean snapshot         | Split first (commercial code enters public history)                                                                                |

## Decision

### Runtime and engine source

- The extension has no backend. Translation runs on an **engine source**: `byok-openai` or `on-device`. A future `hosted` source can be added without changing the translation flow.
- The path selector depends on the engine source, not on a plan:
  - a valid key → AI translation through the background, with on-device as the recovery stage;
  - no key, or AI failure → on-device when the browser supports it;
  - neither → `unavailable`, with a prompt to add a key.
- The completer interface takes `{ endpoint, auth }` rather than a bare key, so a hosted endpoint is one more implementation.

### Provider settings

- Launch provider: **OpenAI only**. Settings show a Provider field (one option today), a masked key (`sk-…abcd`), a model picker with a short list (default `gpt-5-nano`), **Test key** and **Remove key**.
- Stored record, versioned from day one:

```ts
{ version: 1,
  activeProvider: "openai",
  providers: { openai: { apiKey: string, model: string } } }
```

- Next provider step is one OpenAI-compatible adapter (base URL + model), gated by its own quality test set.

### Key custody

- The key lives in extension-origin IndexedDB. Only the background service worker and the Settings page read it. Content scripts and the Reader never receive it; they send source text to the background, which attaches the key and calls `api.openai.com`.
- No `storage.sync`. No passphrase encryption.
- The key never appears in logs, diagnostics, error messages, exports or runtime messages. Tests prove this.
- Settings and the privacy notice say the key is stored unencrypted on the user's device, and recommend a dedicated OpenAI project key with a spending limit.

### Removed from the extension

Sign-in (managed and Google handoff), session handling, plan/trial/quota UI and gates, billing actions, waitlist, product events relay, `/v1/features` fetch, client-version header, `externally_connectable` sign-in pairing.

### Data and telemetry

- No telemetry. Text goes only from the user's machine to the provider the user chose. On-device translation and the Local Spreadsheet Reader never send text anywhere.
- Signals come from the Chrome Web Store dashboard, GitHub, a static uninstall survey (`setUninstallURL` with no identifiers) and a user-initiated **Copy diagnostics** that excludes keys, page text, translations and full URLs.

### Google Sheets Reader

Off at launch through a build-time flag (replacing the backend `/v1/features` flag from ADR 0015). The "download as .xlsx, open in Local Reader" path stays. OAuth verification for `spreadsheets.readonly` is submitted once the Store ID exists; forks create their own OAuth client.

### Repository and workspace

```
v-translated-extension/          private · Vigentix/v-translated-extension
├── AGENTS.md                    private rules + "read readlace/AGENTS.md first"
├── docs/                        ADR 0010–0017, launch/, security/, account-management
├── .scratch/                    private specs and plans
├── backend/                     frozen until a hosted-key offer
├── deploy/
├── web/
├── scripts/setup-workspace.sh   clones readlace/ when missing
└── readlace/                    public · Vigentix/readlace (ignored by the outer repo)
    ├── AGENTS.md, CONTEXT.md, docs/lessons.md, docs/decisions/ (0001–0004, 0020)
    ├── entrypoints/ lib/ components/ shared/ e2e/ tests/
    └── package.json, pnpm-lock.yaml (builds on its own)
```

- Everything an outside contributor needs lives in `readlace/`. The root only adds private material and points to the public docs; it never copies them.
- `readlace/` starts from one clean snapshot commit and is the source of truth for extension code.
- Backend-only shared types (entitlement, billing, quota) move to `backend/`; the backend imports common code from `../readlace/shared`.

### License and brand

- `readlace/` is **Apache-2.0**, with `NOTICE`, DCO sign-off (`Signed-off-by`) in `CONTRIBUTING.md`, and `TRADEMARK.md`: "Readlace" and its logo belong to Vigentix; forks must rename and rebrand before publishing.
- Register the "Readlace" mark. The official Store listing says "Official build by Vigentix" and links the repository.
- Paid value, if any, stays server-side (hosted keys, team features), so the client never needs to close.

### Collaboration

- Public: GitHub Issues and Discussions with templates; triage labels from `docs/agents/triage-labels.md` become GitHub labels.
- Private: `.scratch/` keeps specs, grilling and commercial plans. Large extension specs are drafted there and split into GitHub issues.

## Consequences

- Vigentix runs no server and pays no provider cost for the launch. Users without a key get on-device quality only.
- The privacy story is one sentence with no exceptions; the Store data disclosure is "does not collect".
- Model support is narrow at launch; requests for other providers are expected and answered by the OpenAI-compatible adapter later.
- Competitors may legally reuse the code under Apache-2.0. The moat is brand, speed and a future hosted service.
- `CONTEXT.md` vocabulary for **Managed account**, **Session verification**, plans and quota becomes historical for the extension and must be updated when this lands.
- Layout protection is unchanged: every engine's output still goes through `layout-ellipsis` (ADR 0004).

## Review Trigger

A decision to sell hosted keys or a Team plan; a model change that breaks strict JSON output; abuse of the Readlace name by a fork on the Chrome Web Store.
