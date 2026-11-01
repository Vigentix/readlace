# 0019 — Rename the product to Readlace

## Status

Accepted (2026-10-16). Supersedes the name in [ADR 0018](./0018-rename-to-lingloom.md); the identifier scheme of 0018 carries over with the new name, and the woven-frame mark is replaced by the laced R below.

## Context

ADR 0018 renamed Readloom to Lingloom the same day because `readloom.com` was taken and another reading product used the Readloom name. Before any Lingloom account, domain or listing existed, the operator bought **`readlace.com`** and chose **Readlace** instead.

- _Read_ keeps the product's job in the name: read any page or document in your own language.
- _Lace_ keeps the weaving idea behind the mark and motion: threads laced through a fixed frame, so the layout holds while the language changes.

Nothing is deployed, mailed or stored in the field under Lingloom, so the change is again repository-only.

## Linked Artifacts

| Artifact        | Path                                        | Notes                                    |
| --------------- | ------------------------------------------- | ---------------------------------------- |
| Previous rename | `docs/decisions/0018-rename-to-lingloom.md` | Mark geometry and identifier scheme      |
| Launch kit      | `docs/launch/external-submissions.md`       | Domain, mail, Store, OAuth and SES steps |

## Decision

- The product name is **Readlace** everywhere: extension name and description, UI strings in every locale, web app, emails, legal drafts, Store listing, docs and operator material. Brand and plan names stay untranslated.
- The primary domain is **`readlace.com`** (bought 2026-10-16): web `readlace.com`, API `api.readlace.com`, staging under `staging.readlace.com`.
- Mailboxes: support is **`support@readlace.com`**; system mail is sent from **`Readlace <no-reply@readlace.com>`**.
- Technical identifiers follow the name, as in ADR 0018: packages `readlace` and `@readlace/web`; headers `X-Readlace-Extension-Version` and `X-Readlace-CSRF`; runtime message `READLACE_HANDOFF`; cookies `__Host-readlace_session`, `readlace_session` and `__Secure-readlace_google_signin`; CSS prefixes `readlace-selection__*` and `--rl-*`; env vars `READLACE_*`; deploy paths `/etc/readlace`, `/opt/readlace` and `/var/lib/readlace`; image and unit names `readlace-*`.
- The logo is the **laced R** (chosen 2026-10-16 from three variants; review board https://claude.ai/artifact/VYChk7QiquNDEge1bdfLR1). An indigo `#2F2BA8` stem is the layout that stays put. One coral `#F0614A` thread laces through it to draw the bowl and the leg of the R, which is the translation. The thread passes behind the stem at the top and over it at the waist; that single crossing carries the "lace". All strokes are monoline with round caps and joins.
  - The 128-unit drawing (stroke 16): thread `M29 37H77A19 19 0 0 1 77 75H51L99 103`, stem `M51 25V103`, and the waist crossing redrawn on top `M67 75H51L66.36 83.96`.
  - The hand-tuned 16-unit drawing (stroke 2), used up to 40 px: thread `M2.5 4H10A3 3 0 0 1 10 10H6L13 14`, stem `M6 2V14`, crossing `M8 10H6L8.24 11.28`. Its stem and horizontal runs sit on whole pixels at 16 and 32 px.
  - The monochrome file cuts a gap where each strand passes under the other. Dark surfaces lighten the indigo to `#8F8BF5`. On the web the mark draws itself in: the stem first, then the thread laces through it.
- The wordmark is Be Vietnam Pro Bold at −0.035em tracking, in one ink colour, outlined in `readlace-lockup.svg` and `readlace-wordmark.svg`. Social previews are `web/public/og/readlace-{vi,en}.png`.
- The extension ID stays the same (manifest key unchanged).

## Consequences

- Headers, cookies and runtime message types changed in lockstep on the extension, web and backend. An extension built under the Lingloom name cannot talk to a backend built under Readlace, so the extension and the backend must be rebuilt together.
- Local development databases keep whatever name they already have (`DATABASE_URL` in `.env`).
- The trademark search in issue 01 must be run for "Readlace".

## Review Trigger

If the Readlace trademark search finds a conflict in classes 9 or 42.
