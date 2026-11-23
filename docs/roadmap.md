# Roadmap

Readlace is a free, open-source extension with no Readlace backend: users bring
their own provider API key or translate on-device
([ADR 0020](decisions/0020-open-source-byok.md)). This roadmap follows that
decision. It is a direction, not a promise of dates; GitHub Issues hold the
actual work.

## Available now (0.1)

- Page translation into English, Vietnamese or Japanese, with source language
  auto-detected.
- Dynamic content, menus, dialogs, iframes and later navigation translated in
  place; **Show original** restores the exact page.
- **Always translate this site**, remembered per site with its target language.
- Selection translation in a floating panel.
- Local Spreadsheet Reader for `.csv`, `.xlsx` and `.xlsm`, parsed in the
  browser and never uploaded.
- Layout protection on every engine: long translations are ellipsized with the
  full text in a tooltip ([ADR 0004](decisions/0004-layout-ellipsis.md)).
- Engines: the user's OpenAI key (default model `gpt-5-nano`), or the browser's
  on-device Translator (Chrome 138+ desktop). AI failures fall back to
  on-device.
- No account, no telemetry, and **Copy diagnostics** that leaves out keys, page
  text, translations and full URLs.

## Next

- **Chrome Web Store listing**: "Official build by Vigentix", data disclosure
  "does not collect".
- **Google Sheets Reader**: turned on in the official build after Google OAuth
  verification for `spreadsheets.readonly`, which needs the Store ID first.
  Until then it is an optional build (`WXT_SHEETS_READER=true`).
- **OpenAI-compatible provider**: one adapter (base URL and model), enabled only
  for models that pass their own quality test set with strict JSON output.
- **Quality and stability**: larger translation sample sets, fewer repeated
  translations of unchanged content, clearer retry and rate-limit states, faster
  AI batching.

## Later

- More target languages.
- Accessibility of tooltips and main actions, including keyboard focus.
- Glossaries or domain profiles for more consistent terminology.
- Microsoft Edge and Firefox as supported browsers.
- Google Docs, which is unsupported today.

## Not planned

- A Readlace account, sign-in or telemetry inside the extension.
- Sending text anywhere other than the provider the user chose.

A paid hosted-key offer may come later as a separate service; it would add an
engine source without changing the free extension.
