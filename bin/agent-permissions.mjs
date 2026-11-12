#!/usr/bin/env node

/**
 * CLI Entrypoint for agent-permissions
 *
 * Provides a zero-dependency CLI interface to manage canonical agent permissions,
 * compile configurations, execute test suites, and manage the Orca plugin.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { main as syncMain } from '../scripts/sync-permissions.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
agent-permissions - Unified Coding-Agent Permission Manager & CLI

Usage:
  agent-permissions <command> [options]

Commands:
  sync                     Compile & synchronize canonical rules to all agent configs
  check                    Verify canonical rules and validate against configuration drift
  list                     List installed permission sets across baseline and project scopes
  view <set>               Display allow/deny rules for a specific permission set
  test                     Run the automated Node.js permission test suite
  orca check               Build panel, check manifest, and run Orca plugin tests
  orca install             Build panel and install the plugin into local Orca
  help, --help, -h         Show this help message

Examples:
  agent-permissions sync
  agent-permissions check
  agent-permissions list
  agent-permissions view project
  agent-permissions test
  agent-permissions orca check
`);
}

async function run() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'sync': {
      await syncMain([]);
      break;
    }

    case 'check':
    case '--check': {
      await syncMain(['--check']);
      break;
    }

    case 'list':
    case '--list': {
      await syncMain(['list']);
      break;
    }

    case 'view':
    case '--view': {
      const setName = args[1];
      if (!setName) {
        console.error('Error: Please specify a permission set name to view. Example: agent-permissions view project');
        process.exit(1);
      }
      await syncMain(['view', setName]);
      break;
    }

    case 'test': {
      console.log('[Test Runner] Running Node.js test suite: tests/permissions.test.mjs...');
      try {
        execFileSync(process.execPath, ['--test', path.join(rootDir, 'tests', 'permissions.test.mjs')], {
          cwd: rootDir,
          stdio: 'inherit',
        });
      } catch (err) {
        process.exit(err.status || 1);
      }
      break;
    }

    case 'orca': {
      const sub = args[1];
      const panelScript = path.join(rootDir, 'scripts', 'build-orca-panel.mjs');
      const pluginDir = path.join(rootDir, 'orca-plugin');

      if (sub === 'check') {
        console.log('[Orca Plugin] Building panel bundle...');
        execFileSync('bun', [panelScript], { cwd: rootDir, stdio: 'inherit' });

        console.log('[Orca Plugin] Validating plugin manifest...');
        execFileSync('orca', ['plugin', 'check', 'orca-plugin', '--json'], { cwd: rootDir, stdio: 'inherit' });

        console.log('[Orca Plugin] Running plugin tests...');
        execFileSync('orca', ['plugin', 'test', 'orca-plugin', '--json'], { cwd: rootDir, stdio: 'inherit' });
      } else if (sub === 'install') {
        console.log('[Orca Plugin] Building panel bundle...');
        execFileSync('bun', [panelScript], { cwd: rootDir, stdio: 'inherit' });

        console.log('[Orca Plugin] Installing plugin into Orca...');
        execFileSync('orca', ['plugin', 'install', pluginDir, '--json'], { cwd: rootDir, stdio: 'inherit' });
      } else {
        console.error('Error: Unknown orca command. Supported: "orca check", "orca install"');
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Error: Unknown command "${command}"\n`);
      printHelp();
      process.exit(1);
    }
  }
}

run().catch(err => {
  console.error(`\n[FATAL] ${err.message}`);
  process.exit(1);
});
