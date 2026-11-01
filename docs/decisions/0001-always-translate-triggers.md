# 0001 — Always-translate triggers

## Status

Accepted

## Context

Always-translate was reported broken: skip compared a raw `tabs.detectLanguage` code to `en|vi|ja` (so `en-US` never matched, and a single noisy CLD result could suppress the run), and only the top frame sent `CONTENT_READY`, so nested or late frames never joined a translation run.

The product needs a hostname preference that starts a translation run after reload or document load, skips only when the site is already in the target language, and covers every injected frame — without starting a run when the Always-translate checkbox is ticked, and without adding `webNavigation` or changing host permissions.

## Linked Artifacts

| Artifact   | Path                                                      | Notes                                                                                |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Design     | `docs/plans/2026-08-18-000001-always-translate-design.md` | Approved design; D2–D6 bind this decision                                            |
| Plan       | `docs/plans/2026-08-18-000002-always-translate-plan.md`   | Implementation plan for the design                                                   |
| Glossary   | `CONTEXT.md`                                              | Vocabulary source of truth for page language, frame, and Always-translate preference |
| Story      | `docs/user-story.md`                                      | US-03 Always-translate; US-04 Show original                                          |
| Site scope | `docs/decisions/0002-always-translate-site-scope.md`      | Hostname matching is eTLD+1; supersedes this decision’s exact-hostname clause        |

## Options

| Option                                     | Description                                                                                                                                                                                                                                                                             | Pros                                                                                                                                            | Cons                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Agreement skip + per-frame `CONTENT_READY` | Skip only when BCP-47-normalized `tabs.detectLanguage` and top-frame `html[lang]` both resolve to the same `en\|vi\|ja` equal to the preference target; each injected frame announces `CONTENT_READY` and background starts that frame when the preference is enabled and skip is false | Protects D3 (site language) and D4/D6 (every frame, including late frames); no new permission; popup Page language uses the same resolver label | Extra provider calls on conflict/Unknown; third-party iframes follow the existing translation path; both signals can still agree wrongly |
| Checkbox auto-start                        | Checking Always-translate immediately starts a translation run                                                                                                                                                                                                                          | Checkbox would feel live                                                                                                                        | Rejected: violates D2 — the first run requires Translate; the checkbox only remembers the site preference                                |
| CLD-only skip                              | Skip when `tabs.detectLanguage` alone matches the target                                                                                                                                                                                                                                | Simpler; one Chrome API                                                                                                                         | Rejected: CLD false `en` would hide always-translate; D3 requires site language, not a single unnormalized detector                      |
| Html-first skip                            | Skip when top-frame `html[lang]` is the target (Chromium Translate order)                                                                                                                                                                                                               | Matches browser Translate heuristics                                                                                                            | Rejected: templates often ship `lang="en"`; that recreates the reported skip bug                                                         |
| `webNavigation.getAllFrames`               | Enumerate frames via `webNavigation` and start each one                                                                                                                                                                                                                                 | Explicit frame inventory                                                                                                                        | Rejected: D6/R9 — content-script `CONTENT_READY` covers late frames without adding `webNavigation` or changing `host_permissions`        |

## Decision

Use **agreement skip + per-frame `CONTENT_READY`**.

- Checking Always-translate writes `{ enabled, targetLanguage }` under `alwaysTranslate:<hostname>` and must not start a translation run. First run requires Translate. Reload or document load with the preference enabled auto-starts unless skip applies. Hostname matching is the registrable domain (eTLD+1) in `docs/decisions/0002-always-translate-site-scope.md`; the exact-hostname / no-eTLD+1 clause here is superseded.
- Skip only when `resolvePageLanguage` `skipTarget` equals `preference.targetLanguage`. `skipTarget` is set only when both normalized signals agree on the same `en`, `vi`, or `ja` target. Missing, invalid, `und`, or disagreeing signals → Unknown → do not skip. Nested frames reuse top-frame page language (`htmlLang` from frame 0 only). The popup **Page language** label is the same resolver `label` (conflict → `Unknown`).
- A translation run and Show original cover every injected frame. Every frame with the content script may send `CONTENT_READY`; background may `START_TRANSLATION` to that `frameId` when the preference would auto-start. Late frames self-start if the preference is still enabled and skip is false. Do not add `webNavigation`.

## Consequences

Positive:

- Always-translate no longer false-skips on `en-US` vs `en`, or on a lone noisy CLD/`html[lang]` signal.
- Nested and late frames join the same translation run / Show original coverage as the top frame.
- No new extension permissions.

Trade-offs:

- Conflicted language signals show as Unknown and still auto-translate, which costs extra provider calls.
- Third-party iframes that receive the content script are sent to the provider.
- The checkbox looks inert until Translate or reload.
- A wrong-but-agreed detector pair can still skip.

## Follow-Up

- Required docs updates: `CONTEXT.md` Page language, Frame, and Always-translate preference entries (this change).
- Required proof: resolver and start/skip unit tests, popup no-auto-start-on-checkbox test, then Verify Gate `pnpm test:run` and `pnpm compile` after remaining plan tasks.
- Owner: implementation of `docs/plans/2026-08-18-000002-always-translate-plan.md`.

## Review Trigger

Revisit if always-translate still false-skips after agreement is in production, if SPA/`history` navigations without a new document become in scope, if Chromium html-first skip is reconsidered, or if a `webNavigation` permission is proposed.
