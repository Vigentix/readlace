# Readlace

> Read anything in your language, with the layout intact.

Readlace is an open-source browser extension that translates web pages,
selected text and spreadsheets **in place**. Menus stay on one row, tables keep
their cells, and long translations are ellipsized with the full text in a
tooltip instead of breaking the page.

Readlace is free. There is no account and no Readlace server:

- **With your own OpenAI API key**, translation runs on OpenAI and you pay
  OpenAI directly.
- **Without a key**, Readlace uses the browser's built-in on-device Translator
  (Chrome 138+ desktop), and your text never leaves your computer.

## Features

- **Translate this page** into English, Vietnamese or Japanese. Dynamic content,
  menus, dialogs and later navigation are translated too.
- **Show original** restores the exact page at any time.
- **Always translate this site**, remembered per site with its target language.
- **Selection translation** in a small floating panel.
- **Local Spreadsheet Reader**: open a `.csv`, `.xlsx` or `.xlsm` file as a
  read-only translated grid that keeps worksheets, merged cells, sizes and basic
  styles. The file is parsed in your browser and never uploaded.
- **Google Sheets Reader** (optional build, see below): read the open Google
  Sheet as a translated grid in the side panel, without touching the file.
- Interface in English or Vietnamese.

## Install

The official build will be published on the Chrome Web Store as
"Official build by Vigentix". Until then, build it yourself:

```bash
pnpm install
```

```bash
pnpm build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked** and select `.output/chrome-mv3`.

## Set up AI translation (optional)

1. Create an API key at [platform.openai.com](https://platform.openai.com/api-keys).
   A dedicated project key with a spending limit is recommended.
2. Open the Readlace popup and click the **Settings** (gear) button.
3. Paste the key, pick a model (`gpt-5-nano` is the default) and press
   **Test key**, then **Save**.

The key is stored only in this browser profile and is sent only to OpenAI. See
[PRIVACY.md](PRIVACY.md) for every detail. More providers are planned.

## Develop

Requirements: Node.js 22+, pnpm 11+, Chrome 138+ desktop.

```bash
pnpm install
```

```bash
pnpm dev
```

| Command                               | What it does                                                   |
| ------------------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                            | Builds in watch mode and opens Chrome with the extension       |
| `pnpm build` / `pnpm zip`             | Production build in `.output/chrome-mv3` / zipped              |
| `pnpm build:store` / `pnpm zip:store` | Chrome Web Store build in `.output/store/` (no manifest `key`) |
| `pnpm check`                          | Format, type-check, lint and unit tests                        |
| `pnpm test`                           | Unit and component tests in watch mode                         |
| `pnpm test:e2e`                       | Playwright end-to-end tests (opens real Chrome windows)        |
| `pnpm scan:release-secrets`           | Checks build artifacts for secrets                             |

End-to-end tests need a build with the test Reader configuration:

```bash
WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID=123456789012-readlacereader-web.apps.googleusercontent.com WXT_SHEETS_READER=true pnpm test:e2e
```

If Playwright's Chromium is missing, run `pnpm exec playwright install chromium`
or point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at an installed Chromium.

### Build options

Copy `.env.example` to `.env`. All options are optional:

| Variable                             | Effect                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID` | Public Google **Web application** OAuth client ID. Enables the Reader side panel and **Connect Google Workspace** (scope `spreadsheets.readonly`). Never add a client secret. |
| `WXT_SHEETS_READER=true`             | Turns on the native Google Sheets Reader. Leave it off until your OAuth client is verified by Google.                                                                         |
| `WXT_UNINSTALL_SURVEY_URL`           | Plain HTTPS page opened after the extension is removed (official builds). No query string is allowed, so it cannot identify anyone. Unset means no page.                      |
| `WXT_EXTENSION_PUBLIC_KEY`           | Public key that pins the unpacked extension ID (the redirect URI of your OAuth client depends on it). Defaults to the committed development key.                              |

Forks that enable the Sheets Reader must create their own Google OAuth client;
its redirect URI is `https://<extension-id>.chromiumapp.org/google-workspace`.
See the [Reader guide](docs/google-workspace-reader.md).

## Project layout

| Path             | Contents                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `entrypoints/`   | Background worker, content scripts, popup, Settings page (`options`), Reader side panel |
| `lib/`           | Translation pipeline, layout protection, Reader adapters, i18n, provider settings       |
| `shared/`        | Pure contracts: translation stage, OpenAI completer and router, provider settings       |
| `components/`    | Shared React components                                                                 |
| `tests/`, `e2e/` | Background/content tests and Playwright suites                                          |
| `docs/`          | [Lessons](docs/lessons.md), [decisions](docs/decisions/), Reader guide                  |
| `CONTEXT.md`     | Domain glossary                                                                         |

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) (all
commits need a DCO sign-off) and, for security issues, [SECURITY.md](SECURITY.md).

## License and trademark

The code is licensed under the [Apache License 2.0](LICENSE). "Readlace" and
the Readlace logo are trademarks of Vigentix; forks must use a different name
and logo. See [TRADEMARK.md](TRADEMARK.md) and [NOTICE](NOTICE).
