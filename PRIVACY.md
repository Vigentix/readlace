# Privacy

Readlace has no server and no account. It does not collect analytics,
telemetry or personal data. This page describes exactly where your data goes.

## Text you translate

| How Readlace translates                        | Where the text goes                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **With your OpenAI API key** (set in Settings) | From your browser directly to OpenAI (`api.openai.com`), using your key and the model you chose. OpenAI's API terms and data-retention policy apply. |
| **Without a key**                              | On your device, with the browser's built-in Translator (Chrome 138+ desktop). The text does not leave your computer.                                 |

Readlace never sends your text to Vigentix or any other party.

## Your API key

- Stored in this browser profile only, in the extension's own IndexedDB
  database. It is **not encrypted**, is never synced to other devices and
  is never shown again in full (Settings shows `sk-…abcd`).
- Read only by the extension's background service worker and its Settings page.
  It is never given to web pages or content scripts, and never written to logs
  or diagnostics.
- Sent only to OpenAI: with translation requests, and when you press
  **Test key** (which only checks that the key can use the chosen model).
- **Remove key** in Settings deletes it.

We recommend a dedicated OpenAI project key for Readlace with a spending limit.

## Data stored on your device

In the extension's IndexedDB database, in this browser profile:

- your provider settings (provider, model, API key);
- per-site preferences such as **Always translate this site** and the target
  language;
- saved translations (the translated text, keyed by a hash of the source), so
  pages you revisit do not need new requests; **Clear saved translations** in
  the popup menu removes them;
- counts and timings of your last 20 page translations, for troubleshooting.
  They contain no page text.

## Copy diagnostics

**Copy diagnostics** in Settings puts a small report on your clipboard for bug
reports: the Readlace and browser versions, your UI language, the provider,
model and whether a key is saved or was rejected, on-device support, and the
counts and timings above. It never contains your key (not even its masked
form), page text, translations or URLs. Nothing is sent anywhere unless you
paste it yourself.

## Spreadsheets

- **Local Spreadsheet Reader**: the file you open is parsed in your browser and
  never uploaded. Only the cell text you choose to translate is sent, as
  described under _Text you translate_.
- **Google Sheets Reader** (only in builds that enable it): after you choose
  **Connect Google Workspace**, Readlace requests read-only access
  (`spreadsheets.readonly`) and reads the open sheet through the Google Sheets
  API. The Google access token is kept in the browser's session storage until
  you disconnect or close the browser. Readlace never writes to your files.

## After uninstalling

The official build opens a short, anonymous survey page on readlace.com when
you remove the extension. Its address carries no identifier. Builds made from
this repository open no page unless they set `WXT_UNINSTALL_SURVEY_URL`.

## Permissions

- `tabs`, `scripting` and access to all sites: to translate the pages you ask it
  to and to inject the translation UI.
- `storage` and `sidePanel` (Reader builds): for the Reader's session data and
  side panel.
- `identity` (optional, requested only when you connect Google Workspace).

## Changes

Changes to this page are made in this repository, so its history shows every
revision.
