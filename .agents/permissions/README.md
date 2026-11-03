# Unified Coding-Agent Permissions

This directory contains the canonical command and tool permissions for AI coding agents operating in this repository.

## Architecture

```text
                    company policy
                ~/.agents/permissions/
                          |
                          +
                          |
             project/.agents/permissions/
                          |
                          v
                 permission compiler
              (just agent-permissions-sync)
                          |
              +-----------+-----------+
              |           |           |
              v           v           v
           Claude       Codex     Antigravity
           native       native      native
           config       rules       config
```

Developers continue to invoke their native agent CLIs directly:

```bash
claude
codex
antigravity   # or agy
```

No runtime wrappers, proxies, or interceptors are used. Native agents enforce their native configuration files directly.

---

## 1. Source of Truth

The canonical permission configuration lives under `.agents/permissions/`.
- **Global / Company Baseline:** `~/.agents/permissions/*.yml`
- **Repository / Project Rules:** `<repo>/.agents/permissions/*.yml`

Vendor-native configuration files (`.claude/settings.json`, `.codex/rules/*.rules`, `.gemini/settings.json`) are **generated artifacts** and must **not** be edited or maintained by hand.

---

## 2. Policy Layering & Precedence

Permissions are structured in two layers:
1. **Company / User Baseline (`~/.agents/permissions/`):** Contains enterprise baseline rules, hard security boundaries, and universally permitted read-only inspection commands (e.g. `git status`, `git diff`, `pwd`, `rg`, `grep`, `head`, `tail`).
2. **Project Policy (`<repo>/.agents/permissions/`):** Supplements the organization baseline with commands specific to this repository (e.g. `just test`, `just agent-permissions-sync`, `just agent-permissions-check`, `node --test`).

### Precedence Model
```text
DENY > PROMPT/ASK > ALLOW
```

- A project rule **cannot** weaken, override, or circumvent a baseline `deny`.
- If a project attempts to declare an `allow` rule for any command denied by the baseline (such as `sudo`), the compiler fails loudly with a security violation error.
- At runtime, Codex's native `execpolicy` strictly resolves conflicting rules by selecting `forbidden` over `allow`. Claude Code and Antigravity likewise treat `deny` as overriding `allow`.

---

## 3. How to Synchronize Permissions

To compile canonical permissions into vendor-native files:

```bash
just agent-permissions-sync
```

This command:
1. Validates all canonical `.yml` policies (syntax, supported tools, and safety constraints).
2. Verifies that no project rule weakens baseline denies.
3. Compiles Claude native configuration (`settings.json`).
4. Compiles Antigravity native configuration (`settings.json`).
5. Generates Codex native execpolicy rules (`generated-agents-policy.rules`).
6. Executes `codex execpolicy check` against the test matrix to verify behavior.
7. Synchronizes `~/.agents/permissions/groups/` for compatibility with `agents permissions list/view`.

Synchronization is strictly **deterministic** and **idempotent**. Running the sync command repeatedly produces zero diff.

---

## 4. How to Validate Permissions

To verify permissions without mutating any files:

```bash
just agent-permissions-check
```

This command checks for configuration drift between `.agents/permissions/` and native generated files, returning exit code `0` if in sync and `1` if drift is detected.

To run the automated policy test suite:

```bash
just test
```

---

## 5. Generated Native Files

| Agent | Global Configuration Path | Project Configuration Path | Format |
|---|---|---|---|
| **Claude** | `~/.claude/settings.json` | `<repo>/.claude/settings.json` | JSON (`permissions.allow` / `permissions.deny`) |
| **Codex** | `~/.codex/rules/generated-agents-policy.rules` | `<repo>/.codex/rules/generated-agents-policy.rules` | Starlark (`prefix_rule`) |
| **Antigravity** | `~/.gemini/antigravity-cli/settings.json` | `<repo>/.gemini/settings.json` | JSON (`permissions.allow` / `permissions.deny`) |

### Preserved Files
- Existing user preferences in `~/.claude/settings.json` and `~/.gemini/antigravity-cli/settings.json` (such as themes, models, trusted workspaces) are preserved intact; only the `permissions` block is updated.
- Hand-maintained rule files such as `~/.codex/rules/default.rules` are **never overwritten**.

---

## 6. How Codex Generation Works

AGI CLI currently does not compile allow-lists into Codex execpolicy rules. To fill this gap without running a proxy, our lightweight deterministic compiler generates native Starlark `prefix_rule` declarations:

```python
# GENERATED FILE.
# Source: .agents/permissions/
# Do not edit manually.

prefix_rule(
    pattern = ["just", "test"],
    decision = "allow",
    justification = "Allowed by .agents/permissions/",
)
```

Hard denies compile into `forbidden`:

```python
prefix_rule(
    pattern = ["sudo"],
    decision = "forbidden",
    justification = "Forbidden by shared agent security policy",
)
```

Both user rules (`~/.codex/rules/`) and project rules (`<repo>/.codex/rules/`) are evaluated by Codex natively.

---

## 7. Known Agent Semantic Nuances

1. **Prefix Matching vs Token Matching:**
   - **Codex** matches token arrays (e.g. `pattern = ["git", "status"]`). Any command line starting with those tokens matches the prefix rule.
   - **Claude** matches glob-like patterns (e.g. `Bash(git status)` matches exact command, `Bash(sudo:*)` matches prefix with arguments).
   - **Antigravity** matches command strings in `settings.json` (e.g. `command(git status)` and `command(sudo *)`).
2. **Arbitrary Code Executors:**
   - Blanket allow rules for interpreters/shells (`bash`, `sh`, `python`, `node`, `just`, `make`) are strictly forbidden across all agents to prevent sandbox evasion. Commands must be whitelisted using specific subcommands (e.g. `just test`, `node --test`).
3. **Compound Commands:**
   - Running compound commands under non-whitelisted shells (e.g. `sh -c "git status && sudo rm -rf /"`) does not match the `git status` prefix rule in Codex and is blocked.

---

## 8. Company Baseline Distribution

The company baseline is maintained in the organization repository and cloned/synced to `~/.agents/permissions/`. Individual project repositories only contain project-specific additions in `<repo>/.agents/permissions/`.
