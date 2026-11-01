# 0003 — Translate action gating

## Status

Accepted

## Context

Explicit **Translate** still started a translation run when the page was already the selected target (for example Japanese → Japanese), which called the translation provider. Same-language skip existed only for Always-translate auto-start. The popup kept Translate enabled except while busy or when OpenAI was selected without a key. Show original already keyed off `translated` and stayed restore-only.

The product needs explicit Translate to share the Always-translate `skipTarget` skip, to disable Translate when that skip applies or the tab is already translated into the currently selected target, and to leave Show original enabled only when the page is translated — without new popup copy, without changing Always-translate auto-start or eTLD+1 site scope, and without adding `webNavigation` or changing host permissions.

## Linked Artifacts

| Artifact | Path                                                             | Notes                                                                                       |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Design   | `docs/plans/2026-08-18-000005-translate-action-gating-design.md` | Approved design; D1–D3 bind this decision                                                   |
| Plan     | `docs/plans/2026-08-18-000006-translate-action-gating-plan.md`   | Implementation plan for the design                                                          |
| Glossary | `CONTEXT.md`                                                     | Vocabulary source of truth for translation run, skipTarget, and Always-translate preference |
| Story    | `docs/user-story.md`                                             | US-01 Translate; US-04 Show original stays restore-only                                     |
| Related  | `docs/decisions/0001-always-translate-triggers.md`               | Always-translate auto-start and agreement skip stay Accepted                                |
| Related  | `docs/decisions/0002-always-translate-site-scope.md`             | eTLD+1 site scope unchanged                                                                 |

## Options

| Option                                | Description                                                                                                                                                                                                                                                                                   | Pros                                                                                              | Cons                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `skipTarget` skip + disable Translate | Do not start a translation run or call the provider when `resolvePageLanguage` `skipTarget` equals the selected target; disable Translate in that case and while the tab is already translated into the currently selected target; Show original stays enabled only when `translated` is true | Stops ja→ja API spend; buttons match tab state; skip stays the same agreement as Always-translate | A Page language label of `ja` with `skipTarget: null` still allows Translate; no same-target refresh without Show original first |
| Always-callable Translate             | Leave Translate enabled and start a run whenever the user clicks, including when page language equals target                                                                                                                                                                                  | User can force a provider refresh                                                                 | Rejected: reproduces the reported ja→ja API call                                                                                 |
| Label-only disable                    | Disable Translate whenever the Page language label is `en`, `vi`, or `ja` matching the selected target                                                                                                                                                                                        | Simpler; one visible string                                                                       | Rejected: the label can be CLD-only; that recreates the CLD-only skip rejected in 0001                                           |
| Silent enabled no-op                  | Keep Translate enabled but do not start a run when skip applies                                                                                                                                                                                                                               | No disable styling to reason about                                                                | Rejected: the button looks live then does nothing; no new popup copy to explain it                                               |

## Decision

Use **`skipTarget` skip + disable Translate**.

- Explicit **Translate** must not start a translation run or call the translation provider when `resolvePageLanguage` `skipTarget` equals the selected `targetLanguage`. Skip authority is `skipTarget` only: BCP-47-normalized `tabs.detectLanguage` and top-frame `html[lang]` must agree on the same `en`, `vi`, or `ja`. The Page language label is not skip or disable authority. Checking Always-translate still must not start a translation run.
- Disable Translate when that skip applies, or when the tab is already translated and `CONTENT_STATE.targetLanguage` equals the selected target, or when busy, or when OpenAI is selected without a key. Re-enable after Show original (unless skip still applies) and after the user selects a different target while the page is still showing a translation. Do not add new popup copy; existing disabled-button styling is enough.
- **Show original** stays enabled only when `translated` is true and must not start a translation run. **Retry** remains available after a failed translation run and uses the same disable rules as Translate except it is shown only on failure.
- Always-translate auto-start, eTLD+1 site scope, `webNavigation`, `host_permissions`, saved-translation keys, and piece collection stay as in 0001 and 0002.

## Consequences

Positive:

- Explicit Translate no longer calls the provider when both language signals agree the page is already the selected target.
- Translate and Retry follow tab translation state; Show original stays restore-only.
- Skip stays the same `skipTarget` agreement as Always-translate; the Page language label can still show a CLD-only code without disabling Translate.

Trade-offs:

- A page that only has CLD `ja` (no agreeing `html[lang]`) still shows `ja` and still allows Translate.
- There is no “Translate again” into the same target without Show original first.
- No new popup copy explains why Translate is disabled.

## Follow-Up

- Required docs updates: `CONTEXT.md` Translation run and Always-translate preference; US-01 no-run AC (this change).
- Required proof: `shouldEnableTranslate` unit tests, popup disable / no-send, content skip before provider, then Verify Gate `pnpm test:run` and `pnpm compile` after remaining plan tasks.
- Owner: implementation of `docs/plans/2026-08-18-000006-translate-action-gating-plan.md`.

## Review Trigger

Revisit if a CLD-only Page language label should disable Translate, if users need a same-target provider refresh without Show original, if new popup copy for the skipped state is in scope, or if Always-translate skip rules in 0001 change.
