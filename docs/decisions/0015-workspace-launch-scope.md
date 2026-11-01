# 0015 — Google Workspace scope at commercial launch

## Status

**Amended by [ADR 0020](./0020-open-source-byok.md) (2026-10-31):** the Sheets Reader flag is a build-time flag, default off, instead of the backend `/v1/features` flag.

Accepted (2026-10-13)

## Context

Google Workspace access requests three scopes:

- `documents.readonly` (sensitive): Docs are already temporarily unsupported.
- `spreadsheets.readonly` (sensitive): reads native Sheets.
- `drive.readonly` (**restricted**): downloads Drive Office workbooks.

Public use requires OAuth app verification. Restricted scopes additionally require an annual third-party CASA assessment. An unverified app is limited to 100 users and shows a warning screen.

Target users receive specification workbooks mostly by email and Google Drive.

Chrome disables an installed extension when an update adds new permissions that carry warnings, until each user accepts them.

## Linked Artifacts

| Artifact | Path                                 | Notes                                     |
| -------- | ------------------------------------ | ----------------------------------------- |
| PRD      | `.scratch/commercial-launch/spec.md` | Gated Sheets notice, optional permissions |
| Guide    | `docs/google-workspace-reader.md`    | Current Reader behavior                   |

## Options

| Option                                                                                                                                  | Pros                                     | Cons                                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| Keep all three scopes                                                                                                                   | No feature loss                          | CASA cost and delay before any revenue     |
| `spreadsheets.readonly` + `drive.file` with Picker                                                                                      | No CASA, Drive workbooks still supported | Picker work before launch                  |
| **Launch without the native Sheets Reader; drop `documents.readonly` and `drive.readonly`; verify `spreadsheets.readonly` in parallel** | Fastest public launch                    | Sheets users must download `.xlsx` for now |
| Drop Google OAuth entirely                                                                                                              | Simplest                                 | Loses native Sheets permanently            |

## Decision

- **Public launch ships with the native Sheets Reader gated off** behind a remote flag. Opening a native Sheet shows "coming soon — File → Download → .xlsx, then open in Local Reader", with an **Open local spreadsheet** action.
- Remove `documents.readonly` and `drive.readonly`. Submit OAuth verification for `spreadsheets.readonly` immediately.
- Move `identity` and the Google API host permissions to `optional_permissions`. Request them at **Connect Google Workspace**. This way, re-enabling Workspace never disables the extension for existing users.
- **Next release, priority 1:** Drive workbooks via `drive.file` and Google Picker.

## Consequences

- The Local Spreadsheet Reader carries Pro's workbook value at launch. Its open flow (drag and drop, quick open from the popup) must be smooth.
- When Workspace returns, the OAuth redirect must use the Chrome Web Store extension ID (see ADR 0016).

## Review Trigger

When Google verification for `spreadsheets.readonly` passes, or if Drive-originated workbook demand justifies Picker earlier.
