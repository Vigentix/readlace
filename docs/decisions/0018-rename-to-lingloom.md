# 0018 — Rename the product to Lingloom

## Status

Superseded by [ADR 0019](./0019-rename-to-readlace.md) the same day (2026-10-16): the product name is Readlace. The woven-frame mark decided below carries over unchanged. Kept as history; names below are as decided then.

## Context

The product was renamed from Lexweft to Readloom on 2026-10-12 (woven-R logo). The pre-launch name check (issue 01) then found an existing reading product called Readloom at `readloom.app`, and `readloom.com` is taken. Launching under that name would mean a likely trademark conflict, a confusing Chrome Web Store search and no matching `.com`.

Nothing is deployed yet: no Store listing, no production domain, no mailed users, and no persisted storage key, cookie or header in the field uses the old name. Renaming now costs only a repository change.

## Linked Artifacts

| Artifact | Path                                                                   | Notes                                              |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Issue    | `.scratch/commercial-launch/issues/01-day-one-external-submissions.md` | Name conflict check and domain purchase            |
| Kit      | `docs/launch/external-submissions.md`                                  | Store listing, DNS, SES and OAuth consent material |
| Related  | `docs/decisions/0011-commercial-plans-trial-quota.md`                  | Positioning that the name must carry               |
| Related  | `docs/decisions/0016-distribution-and-hosting.md`                      | Domains and hosting                                |

## Options

| Option                                          | Pros                                                                                                                                    | Cons                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Keep Readloom                                   | No work                                                                                                                                 | Conflicts with an existing product at `readloom.app`; `readloom.com` taken |
| **Lingloom** (ling(ua) + loom, "language loom") | Keeps the loom/weaving brand and palette; says "language", which fits the broad positioning; `lingloom.com`, `.app` and `.io` were free | One more rename before launch                                              |
| A new name without the loom concept             | Fully fresh                                                                                                                             | Loses the woven mark and motion system already built                       |

## Decision

- The product name is **Lingloom** everywhere: extension name and description, UI strings in every locale, web app, emails, legal drafts, Store listing, docs and operator material. Brand and plan names stay untranslated.
- The primary domain is **`lingloom.com`** (web `app.lingloom.com` / `lingloom.com`, API `api.lingloom.com`, staging under `staging.lingloom.com`). `lingloom.app` and `lingloom.io` are bought defensively and redirect.
- Mailboxes: support is **`support@lingloom.com`**; system mail is sent from **`Lingloom <no-reply@lingloom.com>`**.
- Technical identifiers follow the name, since nothing is deployed: package names (`lingloom`, `@lingloom/web`), headers (`X-Lingloom-Extension-Version`, `X-Lingloom-CSRF`), runtime messages (`LINGLOOM_HANDOFF`), cookies (`__Host-lingloom_session`, `lingloom_session`, `__Secure-lingloom_google_signin`), CSS prefixes (`lingloom-selection__*`, `--ll-*` tokens), env vars (`LINGLOOM_*`), deploy paths (`/etc/lingloom`, `/opt/lingloom`, `/var/lib/lingloom`), image and unit names.
- The logo is the **woven frame** (revised 2026-10-16; the first Lingloom mark was a single woven L whose stem stub became a stray 1–2 px fragment at 16 px). Two letter Ls interlace into one square frame on a 16-unit pixel grid: the indigo `#2F2BA8` L (stem `x3 y1 3×12`, foot `x3 y10 12×3`) is the source language and the coral `#F0614A` L, its 180° rotation (bar `x1 y3 12×3`, stem `x10 y3 3×12`), is the translation. Draw order carries the weave, coral over indigo at the top-left and indigo over coral at the bottom-right, so no mask or gap is needed and every edge is a whole pixel at 16, 32, 48 and 128 px. The empty 4×4 centre stands for the layout that stays intact. Only the monochrome file cuts a 1-unit gap where the threads cross. Toolbar icons (16, 32) are full-bleed on a paper tile; 48, 96 and 128 keep padding. Dark surfaces lighten the indigo to `#8F8BF5`. Review board: https://claude.ai/artifact/3iC6uFRXtsut1TH8h5ipnP. The wordmark is Be Vietnam Pro Bold at −0.035em tracking; `lingloom-lockup.svg` and `lingloom-wordmark.svg` carry it as outlines, so they render identically without the font. Social previews are `web/public/og/lingloom-{vi,en}.png` (1200×630), declared in `marketingMetadata`.
- The extension ID stays the same (manifest key unchanged).

## Consequences

- Operators create `/etc/lingloom/*`, `lingloom-*` systemd units and the `lingloom` compose project; no migration is needed because no environment was provisioned under the old names.
- Local development databases keep whatever name they already have (`DATABASE_URL` in `.env`); only the examples suggest `lingloom`.
- Headers, cookies and runtime message types changed in lockstep on the extension, web and backend; an extension build from before the rename cannot talk to a backend after it.
- The trademark search in issue 01 must be repeated for "Lingloom".

## Review Trigger

If the Lingloom trademark search finds a conflict in classes 9 or 42, or the domain purchase fails.
