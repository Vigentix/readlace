# Contributing to Readlace

Thank you for helping. Readlace is an Apache-2.0 browser extension that
translates pages and spreadsheets in place while keeping the layout. Users bring
their own provider API key; there is no Readlace server.

## Ground rules

- Be kind and assume good intent.
- Open an issue before a large change, so we can agree on the approach first.
- Keep pull requests focused: one problem or one feature each.
- Never commit secrets. API keys, tokens and `.env` files stay out of the
  repository and out of issues.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, which certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that
you wrote the change or otherwise have the right to submit it under the
project's license.

Add the sign-off with `git commit -s`. It appends a line with your real name and
email:

```text
Signed-off-by: Your Name <you@example.com>
```

To sign off commits you already made on your branch:

```bash
git rebase --signoff main
```

Pull requests with unsigned commits cannot be merged.

## Set up

Requirements: Node.js 22+, pnpm 11+, and Chrome 138+ desktop for on-device
translation.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` builds the extension and opens a Chrome profile with it loaded. To
try AI translation, open **Settings** from the popup and paste your own OpenAI
API key; without a key Readlace translates on-device.

## Before you open a pull request

```bash
pnpm check
```

It formats, type-checks, lints and runs the unit tests. Add or update tests for
every behavior you change.

End-to-end tests launch real Chrome windows, so they are not part of
`pnpm check`. Run them when you touch the translation lifecycle, layout or the
Reader:

```bash
pnpm test:e2e
```

## Project rules worth knowing

- Read [`docs/lessons.md`](docs/lessons.md) before changing code. It records
  hard-won rules, especially for layout and the translation lifecycle.
- Layout protection (`lib/translate/layout-ellipsis.ts`,
  `assets/content.css`) follows
  [ADR 0004](docs/decisions/0004-layout-ellipsis.md). Changes there need an ADR
  revision.
- Domain terms are defined in [`CONTEXT.md`](CONTEXT.md). Decisions live in
  [`docs/decisions/`](docs/decisions/).
- The user's API key must stay in the background service worker: never pass it
  through content-script or Reader messages, logs, diagnostics or errors.

## Reporting bugs and requesting features

Use the GitHub issue templates. For security problems, see
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE). The Readlace name and logo are covered by the
[trademark policy](TRADEMARK.md).
