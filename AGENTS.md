## Agent skills

### Project

Readlace is an open-source (Apache-2.0) browser extension. Users bring their own provider API key; there is no Readlace backend and no account (`docs/decisions/0020-open-source-byok.md`).

### Mandatory pre-change reading

Before every code change, read `docs/lessons.md`. For layout or translation-lifecycle changes, also read `docs/decisions/0004-layout-ellipsis.md` and run its linked proof contract.

### Issue tracker

Issues live in GitHub Issues for this repository, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles map 1:1 to tracker labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/decisions/`. See `docs/agents/domain.md`.

### codebase navigation

Prefer `srcwalk` over `rg`, `grep`, `cat`, and similar tools. see `srcwalk` skill

### Windows PowerShell 7 Shell

The environment commonly uses **PowerShell 7** (`pwsh`) on Windows. Use this section as shell-context guidance only: follow the shell, dedicated tool, or tool-specific instructions selected by the terminal, IDE, or harness. Apply the examples below only when PowerShell 7 is active.

| Goal                   | ❌ Don't                                         | ✅ Do                                                                   |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Chain commands         | bash-only assumptions                            | `cmd1 && cmd2` / `cmd1 \|\| cmd2`                                       |
| List files             | `ls -la`                                         | `ls` / `Get-ChildItem`                                                  |
| First/last N lines     | `head` / `tail` (not on PATH)                    | `Get-Content file -TotalCount 10` / `Get-Content file -Tail 10`         |
| Read file              | `cat <<EOF`                                      | `cat file` / `Get-Content file`                                         |
| Copy                   | `cp -r a b` with GNU flags                       | `cp -Recurse a b`                                                       |
| Move                   | GNU `mv` flags                                   | `mv a b`                                                                |
| Rename file/folder     | GNU `mv`/`rename` flags                          | `ren old new` / `Rename-Item old new`                                   |
| Delete                 | `rm -rf dir`                                     | `rm -Recurse -Force dir`                                                |
| Make dir               | `mkdir -p a/b`                                   | `mkdir -Force a/b`                                                      |
| Empty/create file      | `touch file`                                     | `ni file -Force` / `New-Item file -ItemType File -Force`                |
| Env set/read           | `export FOO=bar` / `$FOO`                        | `$env:FOO = 'bar'` / `$env:FOO`                                         |
| Find command           | `which node`                                     | `Get-Command node`                                                      |
| Search text            | `grep pat file`                                  | `Select-String pat file`                                                |
| Recursive file find    | `find . -name '*.ts'`                            | `Get-ChildItem -Recurse -Filter *.ts`                                   |
| Line count             | `wc -l file`                                     | `(Get-Content file).Count` / `Measure-Object -Line`                     |
| Processes              | `ps aux` / `kill -9 PID`                         | `Get-Process` / `Stop-Process -Id PID -Force`                           |
| Open URL/file          | `open` / `xdg-open`                              | `Start-Process url` / `ii .` / `Invoke-Item`                            |
| Discard output         | `cmd >/dev/null 2>&1`                            | `cmd > $null 2>&1` / `cmd \| Out-Null`                                  |
| Sleep                  | assume bash-only `sleep` quirks                  | `Start-Sleep -Seconds 2` (alias `sleep` ok)                             |
| Multiline / commit msg | `$(cat <<'EOF' …)` / `<<` (bash HEREDOC)         | `git commit -m @'…'@` or `-m 'one line'`                                |
| Quote / escape         | `\` escape, assume no `$` expand                 | `'` literal, `"` expands `$vars`, escape with `` ` ``                   |
| Exit code              | assume `$?` alone for native exes                | native: `$LASTEXITCODE`; cmdlets/chains: `$?`                           |
| Filter multiple globs  | `Get-ChildItem -Filter a,b` (array → type error) | one `-Filter 'a'`, or `-Include a,b` with `-Recurse`, or `Where-Object` |
