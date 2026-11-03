# Justfile for permission-setup repository

default:
    @just --list

# Synchronize canonical agent permissions to Claude, Codex, and Antigravity native configs
agent-permissions-sync:
    @node scripts/sync-permissions.mjs

# Validate canonical permissions and check that generated configurations are current (no drift)
agent-permissions-check:
    @node scripts/sync-permissions.mjs --check

# Run automated tests for permission rules, precedence, and compiler behavior
test:
    @node --test tests/permissions.test.mjs
