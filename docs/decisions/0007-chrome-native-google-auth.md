# 0007 — Chrome-native Google authentication

## Status

Superseded by [ADR 0008](./0008-universal-browser-tab-google-oauth.md); all OAuth authentication later superseded by ADR 0010 (kept in the private Vigentix records)

## Context

This historical decision followed Google's rejection of the extension's embedded `launchWebAuthFlow` authorization page. It selected `chrome.identity.getAuthToken` as a Chrome-only replacement.

The internal access/refresh session and encrypted provider-credential vault remain the durable authentication boundary. A Google access token is only the short-lived proof used to create that session.

## Linked Artifacts

| Artifact | Path                                                               | Notes                                         |
| -------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Design   | `docs/plans/2026-09-02-000001-chrome-native-google-auth-design.md` | Approved D1-D3 and binding requirements R1-R7 |
| Plan     | `docs/plans/2026-09-02-000002-chrome-native-google-auth-plan.md`   | Implementation and proof plan                 |

## Decision

This ADR previously selected the following behavior; none of it is current implementation guidance:

- Chromium would use `chrome.identity.getAuthToken({ interactive: true })` with a public client ID bound to stable extension ID `imlhpiikjakgljngkdalbfgdpkniejdb`.
- Chromium manifests would request only `openid` and `https://www.googleapis.com/auth/userinfo.email`.
- The extension would send the Google access token to a backend token-exchange endpoint and evict it from Chrome's cache after exchange.
- Render would not need a Google client secret or redirect URI.

ADR 0008 replaced that design with a dedicated top-level browser popup and backend Web OAuth callback/completion flow.

## Consequences

The Chrome-native flow is no longer active. The retained text records rollback history only; current operators and implementers follow ADR 0008.

## Review Trigger

None. ADR 0008 owns future review triggers.
