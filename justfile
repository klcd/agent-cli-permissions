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


# Build, validate, and test the Orca CLI Permissions plugin
orca-plugin-check:
    @bun scripts/build-orca-panel.mjs
    @orca plugin check orca-plugin --json
    @orca plugin test orca-plugin --json

# Install the Orca CLI Permissions plugin into Orca
orca-plugin-install:
    @bun scripts/build-orca-panel.mjs
    @orca plugin install "$(pwd)/orca-plugin" --json
