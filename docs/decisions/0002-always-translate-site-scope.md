# 0002 — Always-translate site scope

## Status

Accepted

## Context

Always-translate was keyed on the exact hostname, so enabling it on `www.yahoo.co.jp` did not auto-start on `news.yahoo.co.jp`. Users treat those hosts as one website. Reliability skip/frame behavior in `docs/decisions/0001-always-translate-triggers.md` stays Accepted; this decision only replaces that record’s exact-hostname / no-eTLD+1 matching rule.

The product needs one Always-translate preference per registrable domain (eTLD+1), still without starting a run when the checkbox is ticked, and without adding `webNavigation` or changing host permissions.

## Linked Artifacts

| Artifact       | Path                                                                 | Notes                                                           |
| -------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Design         | `docs/plans/2026-08-18-000003-always-translate-site-scope-design.md` | Approved design; D1–D3 bind this decision                       |
| Plan           | `docs/plans/2026-08-18-000004-always-translate-site-scope-plan.md`   | Implementation plan for the design                              |
| Glossary       | `CONTEXT.md`                                                         | Vocabulary source of truth for Always-translate preference      |
| Story          | `docs/user-story.md`                                                 | US-03 Always-translate; US-05 translation state                 |
| Prior decision | `docs/decisions/0001-always-translate-triggers.md`                   | Skip/frame stay Accepted; exact-hostname clause superseded here |

## Options

| Option                                         | Description                                                                                                                                                                                                                                                                                                                                   | Pros                                                                                                                                  | Cons                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| eTLD+1 via tldts (`allowPrivateDomains: true`) | Site scope is tldts `getDomain` with `extractHostname: false` and `allowPrivateDomains: true` when that value is non-empty; otherwise the exact hostname. Write the canonical `alwaysTranslate:<eTLD+1>` key. Read canonical, then exact hostname, then any other `alwaysTranslate:*` key whose leftover host shares that site scope (legacy) | Covers Yahoo `www`/`news` as one site; `www` and apex share; private suffixes like `github.io` stay tenant-bounded; no new permission | `mail.yahoo.co.jp` shares the same preference; per-subdomain targets are gone; a storage scan is needed for unmigrated exact keys |
| Exact hostname                                 | Keep matching on the full hostname (previous reliability R12)                                                                                                                                                                                                                                                                                 | Isolates `www` from `news`                                                                                                            | Rejected: reproduces the Yahoo `www` → `news` miss                                                                                |
| Naive label-split without PSL                  | Drop one DNS label and treat the remainder as the site (`*.yahoo.co.jp`)                                                                                                                                                                                                                                                                      | No Public Suffix List dependency                                                                                                      | Rejected: `co.jp` is a public suffix; split is too broad or too narrow without a PSL                                              |
| ICANN-only private-suffix sharing              | Same eTLD+1 helper but `allowPrivateDomains: false`                                                                                                                                                                                                                                                                                           | Still fixes Yahoo (`co.jp` is ICANN)                                                                                                  | Rejected: would share Always-translate across all `*.github.io` / similar private suffixes after one check                        |

## Decision

Use **eTLD+1 via tldts with `allowPrivateDomains: true`**.

- Site scope is tldts `getDomain(hostname, { extractHostname: false, allowPrivateDomains: true })` when that value is a non-empty string; otherwise the exact hostname (IPs, `localhost`, unknown suffixes).
- `www.yahoo.co.jp` and `news.yahoo.co.jp` share `yahoo.co.jp`. `www.example.com` and `example.com` share `example.com`.
- Write the canonical key `alwaysTranslate:<siteScope>`. Checking Always-translate must not start a translation run.
- Read order: canonical eTLD+1 key if present, else the exact-hostname key, else any other `alwaysTranslate:*` key whose hostname has the same site scope (legacy). Canonical wins when both exact and eTLD+1 keys exist.
- Do not add `webNavigation` or change `host_permissions`. Skip, frames, and `CONTENT_READY` stay as in 0001.

## Consequences

Positive:

- One checkbox covers sibling hosts on the same registrable domain (Yahoo `www` and `news`).
- Apex and `www` are the same site.
- Existing exact-hostname keys still apply to sibling hosts until rewritten.
- Private-suffix tenants (`alice.github.io` vs `bob.github.io`) do not share a preference.

Trade-offs:

- Hosts such as `mail.yahoo.co.jp` share the same Always-translate preference; there is no per-subdomain target in this slice.
- Until a canonical key is written, a scan of preference keys is required for unmigrated exact keys.
- Conflicting legacy exact keys under one eTLD+1 resolve to the first matching legacy value until the next checkbox write unifies to the canonical key.

## Follow-Up

- Required docs updates: `CONTEXT.md` Always-translate preference, US-03 / US-05 site wording, README, and 0001 hostname sentence (this change).
- Required proof: site-scope and preference-read unit tests, popup canonical write / no-auto-start-on-checkbox, then Verify Gate `pnpm test:run` and `pnpm compile` after remaining plan tasks.
- Owner: implementation of `docs/plans/2026-08-18-000004-always-translate-site-scope-plan.md`.

## Review Trigger

Revisit if users need Always-translate isolated per subdomain, if tldts private-suffix data drifts from the live Public Suffix List in a product-visible way, if IPs/`localhost` exact-host fallback is wrong, or if a `webNavigation` permission is proposed.
