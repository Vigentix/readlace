# 0008 — Universal browser-tab Google OAuth

## Status

Superseded by ADR 0010 (kept in the private Vigentix records) — reconstructed 2026-10-13 from docs/lessons.md, CONTEXT.md and referencing ADRs; original text was never committed.

Public Google sign-in was later reintroduced by a different design, ADR 0012 (kept in the private Vigentix records): sign-in on the Readlace web app with a nonce-bound handoff code. ADR 0012 does not revive this ADR.

Little evidence survives. Only facts stated by referencing documents are recorded here; the original options, binding requirements and review triggers are unknown.

## Context

[ADR 0007](./0007-chrome-native-google-auth.md) records the history:

- Google rejected the extension's embedded `launchWebAuthFlow` authorization page.
- ADR 0007 then chose Chrome-native `chrome.identity.getAuthToken`. That method is Chrome-only and is bound to the pinned extension ID `imlhpiikjakgljngkdalbfgdpkniejdb`.
- The durable authentication boundary was the backend's internal access/refresh session (plus, at that time, an encrypted provider-credential vault). A Google access token was only short-lived proof used to create that session.

ADR 0008 replaced the Chrome-only method. The title "universal browser-tab" indicates the aim: one flow for every Chromium browser (the same package also targets Comet and Edge, per `CONTEXT.md`), not a Chrome-specific API.

## Linked Artifacts

| Artifact                  | Path                                                           | Notes                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Predecessor               | `docs/decisions/0007-chrome-native-google-auth.md`             | States that ADR 0008 replaced the Chrome-native design with "a dedicated top-level browser popup and backend Web OAuth callback/completion flow" |
| Successor                 | `docs/decisions/0010-managed-account-nestjs-backend.md`        | ADR 0007 says "all OAuth authentication later superseded by ADR 0010"                                                                            |
| Later Google sign-in      | `docs/decisions/0012-public-identity-google-signin-handoff.md` | Summarises ADR 0008 as "a top-level browser-tab OAuth flow"; lists it among the attempts superseded by managed accounts                          |
| Glossary (initial commit) | `CONTEXT.md` at `39c13b9`                                      | **Managed account**: "there is no public signup, OAuth, invitation, forgot-password, or self-service reset" — the state after ADR 0010           |
| Glossary (current)        | `CONTEXT.md`                                                   | **Google sign-in** and **Google Workspace access**: neither is this ADR's flow                                                                   |

## Options

Not recoverable. The comparison against ADR 0007 is the only one on record:

| Option                                                                                | Source             | Outcome                                     |
| ------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------- |
| Embedded `launchWebAuthFlow` authorization page for Readlace login                    | ADR 0007 Context   | Rejected by Google                          |
| Chrome-native `chrome.identity.getAuthToken`                                          | ADR 0007           | Chrome-only; replaced by this ADR           |
| **Top-level browser tab/popup with a backend Web OAuth callback and completion flow** | ADR 0007, ADR 0012 | Accepted here; later superseded by ADR 0010 |

## Decision

As far as the referencing documents state it:

- Readlace login used Google OAuth in a dedicated **top-level browser popup/tab**, not an embedded extension page and not `getAuthToken`.
- The **backend** owned a **Web OAuth callback and completion flow**. The backend, not the extension, completed the Google authorization and established the internal session.
- The internal access/refresh session stayed the durable authentication boundary, as in ADR 0007.

Unknown and not reconstructed: the exact scopes, redirect URIs, how completion was handed back to the extension, and any client-secret handling.

## Consequences

- The Chrome-native flow of ADR 0007 became rollback history only.
- ADR 0010 later removed OAuth from Readlace login entirely. Login became operator-provisioned managed email/password accounts, and no OAuth or public signup remained (initial-commit `CONTEXT.md`, **Managed account**).
- No code from this flow remains in the repository. The current `GET /v1/auth/google/start` / `/v1/auth/google/callback` routes, the `externally_connectable` handoff and `POST /v1/auth/handoff` belong to ADR 0012.
- **Google Workspace access** (`identity.launchWebAuthFlow` with `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID`, `spreadsheets.readonly`) is read-only resource authorization for the Reader. It never signs anyone into Readlace and is not governed by this ADR.

## Review Trigger

None. ADR 0010 and ADR 0012 own identity review triggers.
