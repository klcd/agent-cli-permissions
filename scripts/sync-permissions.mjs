#!/usr/bin/env node

/**
 * Unified Coding-Agent Permission Synchronizer & CLI
 *
 * Compiles canonical YAML permissions (.agents/permissions/*.yml) into:
 *   - Codex execpolicy (.codex/rules/*.rules)
 *   - Claude permissions (.claude/settings.json)
 *   - Antigravity permissions (.gemini/settings.json)
 *
 * Supports two policy layers:
 *   1. Company / Baseline (~/.agents/permissions/)
 *   2. Project-Specific (<repo>/.agents/permissions/)
 *
 * Zero external npm dependencies (pure standard Node.js ES module).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Re-export modular components for external callers and tests
export {
  parsePolicyYaml,
  parseCanonicalRule
} from './lib/parser.mjs';

export {
  FORBIDDEN_BLANKET_EXECUTORS,
  validatePermissionSet,
  loadPolicyDirectory,
  verifyNoDenyWeakening
} from './lib/validator.mjs';

export {
  compileCodexRules,
  compileClaudePermissions,
  compileAntigravityPermissions
} from './lib/compilers.mjs';

import { parsePolicyYaml } from './lib/parser.mjs';
import { loadPolicyDirectory, verifyNoDenyWeakening } from './lib/validator.mjs';
import {
  compileCodexRules,
  compileClaudePermissions,
  compileAntigravityPermissions
} from './lib/compilers.mjs';

/**
 * Safely writes file if content changed, returning boolean indicating if change was made
 */
export function writeIfChanged(filePath, newContent) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === newContent) {
      return false; // No change
    }
  }
  fs.writeFileSync(filePath, newContent, 'utf8');
  return true;
}

/**
 * Updates a JSON file with a new permissions block while preserving other keys
 */
export function updateJsonPermissions(filePath, newPermissions, checkOnly = false) {
  let existingObj = {};
  if (fs.existsSync(filePath)) {
    try {
      existingObj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      existingObj = {};
    }
  }

  const updatedObj = { ...existingObj, permissions: newPermissions };
  const formatted = JSON.stringify(updatedObj, null, 2) + '\n';

  if (checkOnly) {
    if (!fs.existsSync(filePath)) return { changed: true, missing: true };
    const current = fs.readFileSync(filePath, 'utf8');
    return { changed: current !== formatted, missing: false };
  }

  const changed = writeIfChanged(filePath, formatted);
  return { changed, missing: false };
}

/**
 * Runs codex execpolicy check against a set of rules and command tokens
 */
export function checkCodexPolicy(rulePaths, commandTokens) {
  const args = ['execpolicy', 'check'];
  for (const r of rulePaths) {
    args.push('--rules', r);
  }
  args.push('--pretty');
  args.push(...commandTokens);

  try {
    const stdout = execFileSync('codex', args, { encoding: 'utf8' });
    const parsed = JSON.parse(stdout);
    return parsed.decision || 'no-match';
  } catch (err) {
    throw new Error(`codex execpolicy check failed for [${commandTokens.join(' ')}]: ${err.message}`);
  }
}

/**
 * Displays all installed permission sets across baseline and project scopes
 */
export function listPermissions(baselineDir, projectPermsDir) {
  console.log(`\nInstalled Permission Sets:`);

  const printDirSets = (label, dirPath) => {
    console.log(`\n  ${label} (${dirPath}):`);
    if (!fs.existsSync(dirPath)) {
      console.log(`    (none found)`);
      return;
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml'))) continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        const parsed = parsePolicyYaml(fs.readFileSync(fullPath, 'utf8'));
        const name = parsed?.name || path.basename(entry.name, path.extname(entry.name));
        const desc = parsed?.description ? ` - ${parsed.description}` : '';
        const allowCount = Array.isArray(parsed?.allow) ? parsed.allow.length : 0;
        const denyCount = Array.isArray(parsed?.deny) ? parsed.deny.length : 0;
        const askCount = Array.isArray(parsed?.ask) ? parsed.ask.length : 0;
        const askStr = askCount > 0 ? `, ${askCount} ask` : '';
        console.log(`    • ${name}${desc}`);
        console.log(`      (${allowCount} allow, ${denyCount} deny${askStr} rules)`);
        count++;
      } catch (err) {
        console.log(`    • ${entry.name} (error reading: ${err.message})`);
      }
    }
    if (count === 0) {
      console.log(`    (no .yml rule files)`);
    }
  };

  printDirSets('Company / User Baseline', baselineDir);
  printDirSets('Project Policy', projectPermsDir);
  console.log();
}

/**
 * Views details of a specific permission set by name
 */
export function viewPermissionSet(setName, baselineDir, projectPermsDir) {
  if (!setName) {
    console.error(`\n[ERROR] Please specify a permission set name to view. Example: just agent-permissions-view security-baseline`);
    process.exit(1);
  }

  const searchDirs = [baselineDir, projectPermsDir];
  let found = null;
  let foundPath = null;

  for (const d of searchDirs) {
    if (!fs.existsSync(d)) continue;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || (!e.name.endsWith('.yml') && !e.name.endsWith('.yaml'))) continue;
      const p = path.join(d, e.name);
      try {
        const parsed = parsePolicyYaml(fs.readFileSync(p, 'utf8'));
        const name = parsed?.name || path.basename(e.name, path.extname(e.name));
        if (name === setName || e.name === setName || e.name === `${setName}.yml` || e.name === `${setName}.yaml`) {
          found = parsed;
          foundPath = p;
          break;
        }
      } catch {}
    }
    if (found) break;
  }

  if (!found) {
    console.error(`\n[ERROR] Permission set '${setName}' not found in either ${baselineDir} or ${projectPermsDir}`);
    process.exit(1);
  }

  console.log(`\n========================================`);
  console.log(`Permission Set: ${found.name || setName}`);
  console.log(`Source File:    ${foundPath}`);
  if (found.description) {
    console.log(`Description:    ${found.description}`);
  }
  console.log(`========================================\n`);

  if (Array.isArray(found.allow) && found.allow.length > 0) {
    console.log(`Allow Rules (${found.allow.length}):`);
    for (const r of found.allow) {
      console.log(`  ✓ ${r}`);
    }
  } else {
    console.log(`Allow Rules: (none)`);
  }

  if (Array.isArray(found.deny) && found.deny.length > 0) {
    console.log(`\nDeny Rules (${found.deny.length}):`);
    for (const r of found.deny) {
      console.log(`  ✗ ${r}`);
    }
  } else {
    console.log(`\nDeny Rules: (none)`);
  }

  if (Array.isArray(found.ask) && found.ask.length > 0) {
    console.log(`\nAsk/Prompt Rules (${found.ask.length}):`);
    for (const r of found.ask) {
      console.log(`  ? ${r}`);
    }
  }

  console.log();
}

/**
 * Main execution function
 */
export async function main(args = process.argv.slice(2)) {
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const baselineDir = path.join(homeDir, '.agents', 'permissions');
  const projectPermsDir = path.join(projectRoot, '.agents', 'permissions');

  // Handle 'list' mode
  if (args.includes('list') || args.includes('--list')) {
    listPermissions(baselineDir, projectPermsDir);
    return;
  }

  // Handle 'view' mode
  const viewIdx = args.findIndex(a => a === 'view' || a === '--view');
  if (viewIdx !== -1) {
    const setName = args[viewIdx + 1];
    viewPermissionSet(setName, baselineDir, projectPermsDir);
    return;
  }

  const isCheckMode = args.includes('--check') || args.includes('check');

  console.log(`[Permission Sync] Running in ${isCheckMode ? 'CHECK' : 'SYNC'} mode...`);
  console.log(`[Permission Sync] Project root: ${projectRoot}`);

  console.log(`[Permission Sync] Loading company baseline from ${baselineDir}...`);
  const baselinePolicy = loadPolicyDirectory(baselineDir);
  console.log(`[Permission Sync] Loaded baseline: ${baselinePolicy.allow.length} allow, ${baselinePolicy.deny.length} deny rules from [${baselinePolicy.files.join(', ')}]`);

  console.log(`[Permission Sync] Loading project policy from ${projectPermsDir}...`);
  const projectPolicy = loadPolicyDirectory(projectPermsDir);
  console.log(`[Permission Sync] Loaded project: ${projectPolicy.allow.length} allow, ${projectPolicy.deny.length} deny rules from [${projectPolicy.files.join(', ')}]`);

  // 2. Validate security precedence (project cannot weaken baseline deny)
  verifyNoDenyWeakening(baselinePolicy, projectPolicy);

  // 3. Compile Codex rules
  const userCodexRules = compileCodexRules(baselinePolicy, '~/.agents/permissions/');
  const projectCodexRules = compileCodexRules(projectPolicy, '.agents/permissions/');

  const userCodexPath = path.join(homeDir, '.codex', 'rules', 'generated-agents-policy.rules');
  const projectCodexPath = path.join(projectRoot, '.codex', 'rules', 'generated-agents-policy.rules');

  // 4. Compile Claude permissions
  const userClaudePerms = compileClaudePermissions(baselinePolicy);
  const projectClaudePerms = compileClaudePermissions(projectPolicy);

  const userClaudePath = path.join(homeDir, '.claude', 'settings.json');
  const projectClaudePath = path.join(projectRoot, '.claude', 'settings.json');

  // 5. Compile Antigravity permissions
  const userAntigravityPerms = compileAntigravityPermissions(baselinePolicy);
  const projectAntigravityPerms = compileAntigravityPermissions(projectPolicy);

  const userAntigravityPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  const projectAntigravityPath = path.join(projectRoot, '.gemini', 'settings.json');

  const fileActions = [
    { target: 'Codex (User)', path: userCodexPath, type: 'text', content: userCodexRules },
    { target: 'Codex (Project)', path: projectCodexPath, type: 'text', content: projectCodexRules },
    { target: 'Claude (User)', path: userClaudePath, type: 'json', content: userClaudePerms },
    { target: 'Claude (Project)', path: projectClaudePath, type: 'json', content: projectClaudePerms },
    { target: 'Antigravity (User)', path: userAntigravityPath, type: 'json', content: userAntigravityPerms },
    { target: 'Antigravity (Project)', path: projectAntigravityPath, type: 'json', content: projectAntigravityPerms },
  ];

  let driftedCount = 0;

  for (const item of fileActions) {
    if (isCheckMode) {
      let isDrifted = false;
      if (!fs.existsSync(item.path)) {
        isDrifted = true;
        console.error(`  [DRIFT] Missing file: ${item.path} (${item.target})`);
      } else if (item.type === 'text') {
        const cur = fs.readFileSync(item.path, 'utf8');
        if (cur !== item.content) {
          isDrifted = true;
          console.error(`  [DRIFT] Out of sync: ${item.path} (${item.target})`);
        }
      } else if (item.type === 'json') {
        const res = updateJsonPermissions(item.path, item.content, true);
        if (res.changed) {
          isDrifted = true;
          console.error(`  [DRIFT] Out of sync: ${item.path} (${item.target})`);
        }
      }
      if (isDrifted) driftedCount++;
    } else {
      let changed = false;
      if (item.type === 'text') {
        changed = writeIfChanged(item.path, item.content);
      } else if (item.type === 'json') {
        const res = updateJsonPermissions(item.path, item.content, false);
        changed = res.changed;
      }
      console.log(`  [${changed ? 'UPDATED' : 'UP-TO-DATE'}] ${item.target} -> ${item.path}`);
    }
  }

  if (isCheckMode && driftedCount > 0) {
    console.error(`\n[ERROR] Check failed: ${driftedCount} target file(s) are missing or drifted! Run 'just agent-permissions-sync'.`);
    process.exit(1);
  }

  // 6. Validate with Codex execpolicy check
  console.log(`\n[Permission Validation] Running codex execpolicy assertions...`);
  const ruleFilesToCheck = [userCodexPath, projectCodexPath].filter(p => fs.existsSync(p));

  const testAssertions = [
    { cmd: ['git', 'status'], expected: 'allow', desc: 'Baseline allow: git status' },
    { cmd: ['git', 'status', '--short'], expected: 'allow', desc: 'Baseline pattern: git status --short' },
    { cmd: ['git', 'diff'], expected: 'allow', desc: 'Baseline allow: git diff' },
    { cmd: ['git', 'diff', '--staged'], expected: 'allow', desc: 'Baseline pattern: git diff --staged' },
    { cmd: ['pwd'], expected: 'allow', desc: 'Baseline allow: pwd' },
    { cmd: ['rg', 'test'], expected: 'allow', desc: 'Baseline pattern: rg test' },
    { cmd: ['grep', '-rn', 'foo', '.'], expected: 'allow', desc: 'Baseline pattern: grep -rn foo .' },
    { cmd: ['docker', 'ps'], expected: 'allow', desc: 'Infrastructure allow: docker ps' },
    { cmd: ['docker', 'ps', '-a'], expected: 'allow', desc: 'Infrastructure pattern: docker ps -a' },
    { cmd: ['kubectl', 'get', 'pods'], expected: 'allow', desc: 'Infrastructure pattern: kubectl get pods' },
    { cmd: ['terraform', 'validate'], expected: 'allow', desc: 'Infrastructure allow: terraform validate' },
    { cmd: ['just', 'test'], expected: 'allow', desc: 'Project allow: just test' },
    { cmd: ['just', 'test', 'tests/permissions.test.mjs'], expected: 'allow', desc: 'Project pattern: just test with args' },
    { cmd: ['git', 'add', '-A'], expected: 'allow', desc: 'Project pattern: git add -A' },
    { cmd: ['sudo', 'true'], expected: 'forbidden', desc: 'Baseline deny: sudo true' },
    { cmd: ['sudo', 'rm', '-rf', '/'], expected: 'forbidden', desc: 'Baseline deny: sudo rm -rf /' },
    { cmd: ['su', '-'], expected: 'forbidden', desc: 'Baseline deny: su -' },
    { cmd: ['doas', 'ls'], expected: 'forbidden', desc: 'Baseline deny: doas ls' },
    { cmd: ['rm', '-rf', '/'], expected: 'forbidden', desc: 'Baseline deny: rm -rf /' },
    { cmd: ['dd', 'if=/dev/zero', 'of=/dev/sda'], expected: 'forbidden', desc: 'Baseline deny: dd' },
  ];

  let testFailures = 0;
  for (const test of testAssertions) {
    if (!test.expected) test.expected = 'allow';
    const actual = checkCodexPolicy(ruleFilesToCheck, test.cmd);
    if (actual === test.expected) {
      console.log(`  ✓ ${test.desc} -> ${actual}`);
    } else {
      console.error(`  ✗ ${test.desc} -> FAILED (expected: ${test.expected}, got: ${actual})`);
      testFailures++;
    }
  }

  if (testFailures > 0) {
    console.error(`\n[ERROR] Policy validation failed with ${testFailures} error(s)!`);
    process.exit(1);
  }

  console.log(`\n[Permission Sync] Successfully completed! All checks passed.`);
}

// If invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`\n[FATAL] ${err.message}`);
    process.exit(1);
  });
}
