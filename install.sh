#!/bin/sh
# ==============================================================================
# Agent CLI Permissions — Enterprise Bootstrap Installer
#
# Automates zero-privilege deployment of company agent security baselines:
#   1. Validates Node.js runtime environment (>= 18)
#   2. Configures remote company baseline URL (if COMPANY_PERMISSIONS_URL is set)
#   3. Synchronizes native configurations (Claude, Codex, Antigravity, Cursor, etc.)
#   4. Installs SessionStart auto-sync hooks so AI agents auto-refresh on launch
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/klcd/agent-cli-permissions/main/install.sh | sh
#
# With custom company policy URL:
#   COMPANY_PERMISSIONS_URL="https://corp.internal/agents/policy.yml" curl -fsSL ... | sh
# ==============================================================================

set -eu

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

printf "${BOLD}${BLUE}=== Agent CLI Permissions — Enterprise Bootstrap Installer ===${NC}\n\n"

# 1. Check Node.js runtime
if ! command -v node >/dev/null 2>&1; then
  printf "${RED}Error: Node.js (version 18 or higher) is required but was not found.${NC}\n"
  printf "Please install Node.js via your system package manager:\n"
  printf "  - macOS: brew install node\n"
  printf "  - Ubuntu/Debian: sudo apt update && sudo apt install nodejs npm\n"
  printf "  - Nix: nix-shell -p nodejs\n"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf "${RED}Error: Node.js version 18+ is required. Found: $(node -v)${NC}\n"
  exit 1
fi

printf "${GREEN}✓ Node.js $(node -v) detected${NC}\n"

# 2. Configure company baseline URL if provided
AGENTS_DIR="${HOME}/.agents"
mkdir -p "${AGENTS_DIR}/permissions"
mkdir -p "${AGENTS_DIR}/cache"

COMPANY_URL="${COMPANY_PERMISSIONS_URL:-${1:-}}"

if [ -n "$COMPANY_URL" ]; then
  printf "Configuring company remote baseline: ${BOLD}%s${NC}\n" "$COMPANY_URL"
  cat <<EOF > "${AGENTS_DIR}/config.json"
{
  "remoteBaselineUrl": "${COMPANY_URL}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
  printf "${GREEN}✓ Saved company baseline configuration to ~/.agents/config.json${NC}\n"
fi

# 3. Synchronize native configurations
printf "\n${BOLD}Synchronizing agent permission configurations...${NC}\n"
if [ -n "$COMPANY_URL" ]; then
  npx --yes agent-cli-permissions sync --remote "$COMPANY_URL"
else
  npx --yes agent-cli-permissions sync
fi

# 4. Install SessionStart auto-sync hook
printf "\n${BOLD}Installing agent auto-sync hook...${NC}\n"
npx --yes agent-cli-permissions install-hooks --global

printf "\n${GREEN}${BOLD}✓ Installation complete!${NC}\n"
printf "Company security guardrails are active and will automatically refresh when AI agents start.\n"
printf "Run ${BOLD}npx agent-cli-permissions --help${NC} to view available commands.\n"
