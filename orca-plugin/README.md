# Agent CLI Permissions — Orca Plugin (`local.agent-permissions`)

Part of [`permission-setup`](../README.md). Inspects canonical `~/.agents/permissions/*.yml` and `<repo>/.agents/permissions/*.yml` rules (`DENY > ASK > ALLOW`), evaluates CLI commands against active permission sets, and runs [`scripts/sync-permissions.mjs`](../scripts/sync-permissions.mjs) with 1 click to compile rules into Claude Code, Codex, Antigravity, Cursor, OpenCode, Grok, Kimi, and Droid native configurations.

## Features

1. **Zero Host Capabilities (`"capabilities": []`)**: Runs with zero requested Orca host capabilities.
2. **1-Click `Sync Rules` Button & Command Palette (`agentPermissions.sync`)**: Compiles canonical `.agents/permissions/*.yml` rules directly via `scripts/sync-permissions.mjs`.
3. **Interactive `Check CLI Permission` Evaluator**: Test any command (e.g. `git status`, `chmod -R 777 /`, `orca orchestration worker-start`) against `DENY > ASK > ALLOW` precedence.
4. **Compact Foldable Application Cards with Opaque Hover Tooltips**: Browse rules grouped by binary (`git`, `docker`, `kubectl`, `rm`, `chmod`, etc.) with instant hover tooltips showing the rule rationale, source YAML file, and synced agent targets.

## Build, Test & Install

```bash
bun scripts/build-orca-panel.mjs
orca plugin check orca-plugin --json
orca plugin test orca-plugin --json
orca plugin install "/Users/cedric/Projects/AgenticCoding/permission-setup/orca-plugin" --json
```
