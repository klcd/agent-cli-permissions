# 1. Keep the Orca plugin worker a minimal, review-friendly permissions core

- Status: Accepted
- Date: 2026-11-13
- Deciders: Cedric Klinkert

## Context

`orca-plugin/` ships an Orca plugin with `execution: trusted-worker` — its `main`
(`src/worker.ts`) runs as a Node process with the user's access to their machine.
Trusted-worker plugins are listed in Orca's public directory only after a human maintainer
reads the code (see Orca's [plugin listing policy](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-listing-policy.md),
rules 3 "no impersonation" and 4 "safe code"). The size and behaviour of the reviewed code
therefore directly determine whether, and how quickly, the plugin can be listed.

The worker had grown to ~4,670 lines because it was seeded from a sibling plugin,
`ade-nvidia-openshell-plugin`. It carried an entire OpenShell sandbox subsystem that this
plugin — a permission-rule *viewer* — does not need:

- `sandbox/sandbox-control.ts` spawned the external `openshell` binary (`execFile`/`spawn`).
- `policy/l7-mutator.ts` wrote network-policy files and spawned `openshell`.
- `state/session-egress.ts`, `state/sandbox-mode.ts`, `state/sandbox-registry.ts`,
  `state/worktree-paths.ts`, `state/file-lock.ts` tracked sandbox/egress state on disk.
- `context/orca-context.ts` read Orca's `orca-runtime.json` **auth token** and opened Orca's
  **private unix socket** to call `worktree.ps`, bypassing the capability system.
- `policy/report-builder.ts` ran all of the above on the panel's report path: building a
  report **deleted and wrote files** and **spawned processes**.

The panel rendered almost none of it (`delegation`, `sandboxEnabled`, `activeAgentSessions`,
etc. were computed but never shown). The manifest declared `capabilities: []`, which was
misleading because the socket/token path reached Orca's internals without a declared grant.

## Decision

Scope the shipped worker down to the plugin's actual job: read `.agents/permissions/*.yml`
(global + project), show the rules under DENY > ASK > ALLOW, test a command, and sync the
rules to native agent configs.

- **Reviewed worker surface is now ~650 lines**: `worker.ts`, `types.ts`,
  `policy-inspector.ts` (barrel), `parsers/permission-yaml.ts`, `policy/evaluator.ts`,
  `policy/report-builder.ts`. All of the sandbox/L7/egress/delegation/worktree/openshell/
  orca-context modules are deleted.
- **No process spawning on the read path; no filesystem writes while building a report.**
  Building a report is pure file reads. The only `execFile` is in the Sync / Enforce
  handlers, which run this project's own bundled CLI (`bin/agent-permissions.mjs`) and never
  arbitrary input.
- **Workspace detection uses the documented host API**, not Orca internals: the worker calls
  `workspace.readContext` (focused name/branch) and `workspace.list` (its path). This
  requires capability `workspace:read`; the palette command's result toast requires
  `notifications:show`. The manifest now declares exactly those two.
- **Agent names are nominative.** The cover labels Claude Code / Codex / Antigravity / Cursor
  / OpenCode under "COMPATIBLE WITH" and the manifest description frames them as native-format
  sync targets, to satisfy the no-impersonation rule.
- `orca-plugin/REVIEW.md` maps the worker surface, every file read, and the single exec for
  the listing reviewer.

## Consequences

- The listing-review surface is small and obviously safe: pure reads, two honest capabilities,
  one documented exec. This should clear the maintainer review faster and makes future audits
  cheap.
- When no workspace is focused, the panel shows only the global (company-baseline) rules under
  a `(no workspace)` label. A headless `orca plugin shot` / `orca plugin dev request` has no
  focused workspace, so it shows global-only; real interactive use resolves the project.
- Installing the plugin now prompts for `workspace:read` + `notifications:show` instead of
  nothing. This is a deliberate trade: a truthful, legible grant in place of a covert socket.
- The OpenShell sandbox feature set is **not** available from this plugin. If that capability
  is ever wanted, it belongs in a separate plugin (or back in `ade-nvidia-openshell-plugin`),
  not folded into this permissions viewer. **Do not reintroduce the removed subsystem here.**

## Alternatives considered

- **Keep the features, de-risk in place** (make the report read-only, split the barrel, add
  REVIEW.md): less code removed, kept dead panel-less machinery in the reviewed surface.
- **Document only** (add REVIEW.md, change nothing): the reviewer would still read ~4,670
  lines of sandbox code. Rejected — does not address the actual liability.
