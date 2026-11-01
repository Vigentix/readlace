## What and why

<!-- What does this change do, and which issue does it address? -->

## How it was tested

- [ ] `pnpm check`
- [ ] `pnpm test:e2e` (needed for translation lifecycle, layout or Reader changes)
- [ ] Tried it in Chrome with the built extension

## Checklist

- [ ] Every commit is signed off (`git commit -s`, see CONTRIBUTING.md)
- [ ] Read `docs/lessons.md`; layout changes follow ADR 0004
- [ ] The API key never leaves the background worker (no messages, logs or diagnostics)
- [ ] User-facing strings exist in English and Vietnamese
