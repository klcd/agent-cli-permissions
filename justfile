# Justfile for permission-setup repository

default:
    @just --list

# Synchronize canonical agent permissions to Claude, Codex, and Antigravity native configs
agent-permissions-sync:
    @node scripts/sync-permissions.mjs

# Validate canonical permissions and check that generated configurations are current (no drift)
agent-permissions-check:
    @node scripts/sync-permissions.mjs --check

# List installed permission sets across baseline and project scopes
agent-permissions-list:
    @node scripts/sync-permissions.mjs list

# View the allow and deny rules for a specific permission set
agent-permissions-view set:
    @node scripts/sync-permissions.mjs view {{set}}

# Run automated tests for permission rules, precedence, and compiler behavior
test:
    @node --test tests/permissions.test.mjs

