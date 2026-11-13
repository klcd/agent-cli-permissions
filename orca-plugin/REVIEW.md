# Reviewer's map

This is a short guide to everything the plugin runs, for the Orca listing review.
The plugin's whole job: **read permission rule files and show them.**

## Declared access (`orca-plugin.json`)

- `execution: trusted-worker` — the worker (`src/worker.ts`) runs in a Node process.
- `capabilities`:
  - `workspace:read` — to know which project's rules to show (name/branch/path of the
    focused workspace), via the documented `workspace.readContext` + `workspace.list`.
  - `notifications:show` — the palette command shows its result as a desktop notification.

That is the complete list. The worker uses no other host methods.

## The worker surface (what runs in the trusted process)

| File | Lines | What it does | Side effects |
|------|------:|--------------|--------------|
| `src/worker.ts` | ~190 | Registers 4 panel handlers + 1 command; resolves the workspace via the host API | Shells out **only** to the bundled sync CLI on Sync/Enforce (see below) |
| `src/policy/report-builder.ts` | ~75 | Builds the panel's report | **Reads files only** — never writes, never spawns |
| `src/parsers/permission-yaml.ts` | ~270 | Parses `.agents/permissions/*.yml`; inspects native agent config files | **Reads files only** |
| `src/policy/evaluator.ts` | ~75 | Pure DENY > ASK > ALLOW matching for one command | None (pure function) |
| `src/types.ts`, `src/policy-inspector.ts` | ~130 | Type definitions + a re-export barrel | None |

Files read: `~/.agents/permissions/*.yml`, `<workspace>/.agents/permissions/*.yml`, and the
native agent config files (`.claude/settings.json`, `.codex/rules/*.rules`, `.gemini/settings.json`,
`~/.agents/config.json`, `.git/HEAD`, `.git/hooks/pre-commit`) — all read-only, to report status.

## The only process execution

`syncCanonicalPermissions` / `installHooksHandler` in `worker.ts` run this project's own
`bin/agent-permissions.mjs` (or `src/sync-permissions.mjs`) with `node`, and only when that file
exists next to the installed plugin. This is the "Sync Rules" / "Enforce" buttons writing the
canonical rules out to each native agent config. It never runs arbitrary or user-supplied input.

## Not present

No sandbox control, no network/L7 policy mutation, no process spawning on the read path, no
access to Orca's internal state files or sockets, no telemetry or analytics.
