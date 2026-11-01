# Issue tracker: GitHub Issues

Issues and feature requests for Readlace live in GitHub Issues on this
repository (`Vigentix/readlace`). Use the `gh` CLI for every operation.

## Conventions

- One issue per independently shippable slice. A larger plan becomes a parent
  issue with a task list linking its child issues.
- Triage state is a label (see `triage-labels.md` for the role strings).
- Conversation happens in issue comments.
- Bug reports name the browser and version, the page (or a minimal
  reproduction), the steps and the output of **Copy diagnostics** from
  Settings (it never contains keys, page text or URLs). Never paste an API key.

## When a skill says "publish to the issue tracker"

```bash
gh issue create --title "<title>" --body-file <file> --label needs-triage
```

## When a skill says "fetch the relevant ticket"

```bash
gh issue view <number> --comments
```

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: a parent issue whose body holds Notes, Decisions so far and Fog.
- **Child ticket**: an issue linked from the map's task list, with the question
  in the body and a `type:research|prototype|grilling|task` label.
- **Blocking**: a `Blocked by: #N, #N` line near the top of the body. A ticket
  is unblocked when every listed issue is closed.
- **Frontier**: open, unblocked, unassigned child issues; lowest number wins.
- **Claim**: assign yourself (`gh issue edit <n> --add-assignee @me`) before any
  work.
- **Resolve**: comment the answer under an `## Answer` heading, close the issue,
  then add a pointer (gist + link) to the map's Decisions so far.
