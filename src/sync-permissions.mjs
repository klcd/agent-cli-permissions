#!/usr/bin/env node

/**
 * Unified Coding-Agent Permission Synchronizer & CLI
 *
 * Compiles canonical YAML permissions (.agents/permissions/*.yml) into:
 *   - Codex execpolicy (.codex/rules/*.rules)
 *   - Claude permissions (.claude/settings.json)
 *   - Antigravity permissions (.gemini/settings.json)
 *   - Cursor permissions (.cursor/cli-config.json)
 *   - OpenCode permissions (opencode.json)
 *   - Grok permissions (.grok/config.json)
 *   - Kimi permissions (.kimi-code/config.toml)
 *   - Droid permissions (.factory/settings.json)
 *
 * Agents that natively read from .agents/ are identified via requiresNativeCompiler()
 * and skipped from redundant compilation.
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
  compileAntigravityPermissions,
  compileCursorPermissions,
  compileOpenCodePermissions,
  compileGrokPermissions,
  compileKimiPermissions,
  compileDroidPermissions,
  AGENTS_READING_CANONICAL_DIRECTLY,
  requiresNativeCompiler
} from './lib/compilers.mjs';

export {
  isPurePermissionsFile,
  getExpectedGitignoreEntries,
  syncGitignore
} from './lib/gitignore.mjs';

export {
  resolveRemoteBaselineUrl,
  fetchRemotePolicy,
  mergePolicies,
  installSessionStartHook,
  installGitHook
} from './lib/remote-policy.mjs';

import { parsePolicyYaml } from './lib/parser.mjs';
import { loadPolicyDirectory, verifyNoDenyWeakening } from './lib/validator.mjs';
import {
  resolveRemoteBaselineUrl,
  fetchRemotePolicy,
  mergePolicies,
  installSessionStartHook,
  installGitHook
} from './lib/remote-policy.mjs';
import {
  compileCodexRules,
  compileClaudePermissions,
  compileAntigravityPermissions,
  compileCursorPermissions,
  compileOpenCodePermissions,
  requiresNativeCompiler
} from './lib/compilers.mjs';
import {
  isPurePermissionsFile,
  syncGitignore
} from './lib/gitignore.mjs';

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
 * Updates a JSON file with a new section block while preserving other keys
 */
export function updateJsonSection(filePath, keyName, newContent, checkOnly = false) {
  // If filePath is a symlink pointing into /nix/store, skip writing to avoid EROFS
  if (fs.existsSync(filePath)) {
    try {
      const real = fs.realpathSync(filePath);
      if (real.startsWith('/nix/store/')) {
        return { changed: false, missing: false, readOnly: true };
      }
    } catch {}
  }

  let existingObj = {};
  if (fs.existsSync(filePath)) {
    try {
      existingObj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      existingObj = {};
    }
  }

  const updatedObj = { ...existingObj, [keyName]: newContent };
  const formatted = JSON.stringify(updatedObj, null, 2) + '\n';

  if (checkOnly) {
    if (!fs.existsSync(filePath)) return { changed: true, missing: true, readOnly: false };
    const current = fs.readFileSync(filePath, 'utf8');
    return { changed: current !== formatted, missing: false, readOnly: false };
  }

  const changed = writeIfChanged(filePath, formatted);
  return { changed, missing: false, readOnly: false };
}

/**
 * Updates a JSON file with a new permissions block while preserving other keys (backward compatibility)
 */
export function updateJsonPermissions(filePath, newPermissions, checkOnly = false) {
  return updateJsonSection(filePath, 'permissions', newPermissions, checkOnly);
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
    console.error(`\n[ERROR] Please specify a permission set name to view. Example: agent-permissions view security-baseline`);
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

  // Handle 'install-hooks' mode
  if (args.includes('install-hooks')) {
    const isGlobal = args.includes('--global') || !args.includes('--project');
    const res = installSessionStartHook({ global: isGlobal, projectRoot, homeDir });
    console.log(`[Hooks Installer] ${res.updated ? 'Configured' : 'Already active'}: SessionStart auto-sync hook in ${res.targetFile}`);
    return;
  }

  // Handle 'install-git-hook' mode
  if (args.includes('install-git-hook')) {
    const hookType = args.find(a => ['pre-commit', 'post-checkout', 'pre-push'].includes(a)) || 'pre-commit';
    const res = installGitHook(projectRoot, hookType);
    console.log(`[Git Hook Installer] ${res.message}`);
    return;
  }

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
  const isSilent = args.includes('--silent') || args.includes('-s');
  const log = (...msg) => { if (!isSilent) console.log(...msg); };
  const warn = (...msg) => { if (!isSilent) console.warn(...msg); };

  log(`[Permission Sync] Running in ${isCheckMode ? 'CHECK' : 'SYNC'} mode...`);
  log(`[Permission Sync] Project root: ${projectRoot}`);

  // 1. Load baseline policy (local directory + optional remote company webpage/URL)
  const remoteIdx = args.findIndex(a => a === '--remote' || a === '--remote-url');
  const cliRemoteUrl = remoteIdx !== -1 ? args[remoteIdx + 1] : null;
  const remoteUrl = resolveRemoteBaselineUrl({ remoteUrl: cliRemoteUrl }, projectRoot, homeDir);

  log(`[Permission Sync] Loading company baseline from ${baselineDir}...`);
  let baselinePolicy = loadPolicyDirectory(baselineDir);

  if (remoteUrl) {
    log(`[Permission Sync] Fetching remote company policy from ${remoteUrl}...`);
    try {
      const remotePolicy = await fetchRemotePolicy(remoteUrl);
      log(`[Permission Sync] Loaded remote baseline: ${remotePolicy.allow.length} allow, ${remotePolicy.deny.length} deny rules${remotePolicy.fromCache ? ' (from local cache)' : ''}`);
      baselinePolicy = mergePolicies(baselinePolicy, remotePolicy);
    } catch (err) {
      if (isCheckMode) {
        console.error(`[ERROR] Failed to fetch remote company policy: ${err.message}`);
        process.exit(1);
      } else {
        warn(`[WARNING] Remote company policy unavailable (${err.message}). Proceeding with local baseline.`);
      }
    }
  }

  log(`[Permission Sync] Loaded baseline: ${baselinePolicy.allow.length} allow, ${baselinePolicy.deny.length} deny rules from [${baselinePolicy.files.join(', ')}]`);

  log(`[Permission Sync] Loading project policy from ${projectPermsDir}...`);
  const projectPolicy = loadPolicyDirectory(projectPermsDir);
  log(`[Permission Sync] Loaded project: ${projectPolicy.allow.length} allow, ${projectPolicy.deny.length} deny rules from [${projectPolicy.files.join(', ')}]`);

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
  // If .claude/settings.json has other configs (hooks, MCP), write permissions to .claude/settings.local.json
  const projectClaudeSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const projectClaudeLocalPath = path.join(projectRoot, '.claude', 'settings.local.json');
  const hasOtherClaudeConfigs = !isPurePermissionsFile(projectClaudeSettingsPath);
  const projectClaudePath = hasOtherClaudeConfigs ? projectClaudeLocalPath : projectClaudeSettingsPath;

  // 5. Compile Antigravity permissions
  const userAntigravityPerms = compileAntigravityPermissions(baselinePolicy);
  const projectAntigravityPerms = compileAntigravityPermissions(projectPolicy);
  const userAntigravityPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  const projectAntigravityPath = path.join(projectRoot, '.gemini', 'settings.json');

  // 6. Compile Cursor permissions (Shell syntax)
  const userCursorPerms = compileCursorPermissions(baselinePolicy);
  const projectCursorPerms = compileCursorPermissions(projectPolicy);
  const userCursorPath = path.join(homeDir, '.cursor', 'cli-config.json');
  const projectCursorPath = path.join(projectRoot, '.cursor', 'cli-config.json');

  // 7. Compile OpenCode permissions (permission.bash)
  const userOpenCodePerms = compileOpenCodePermissions(baselinePolicy).permission;
  const projectOpenCodePerms = compileOpenCodePermissions(projectPolicy).permission;
  const userOpenCodePath = path.join(homeDir, '.config', 'opencode', 'opencode.json');
  const projectOpenCodePath = path.join(projectRoot, 'opencode.json');

  const candidateActions = [
    { agent: 'codex', target: 'Codex (User)', path: userCodexPath, type: 'text', content: userCodexRules },
    { agent: 'codex', target: 'Codex (Project)', path: projectCodexPath, type: 'text', content: projectCodexRules },
    { agent: 'claude', target: `Claude (${hasOtherClaudeConfigs ? 'Project Local' : 'Project'})`, path: projectClaudePath, type: 'json-permissions', content: projectClaudePerms },
    { agent: 'claude', target: 'Claude (User)', path: userClaudePath, type: 'json-permissions', content: userClaudePerms },
    { agent: 'antigravity', target: 'Antigravity (User)', path: userAntigravityPath, type: 'json-permissions', content: userAntigravityPerms },
    { agent: 'antigravity', target: 'Antigravity (Project)', path: projectAntigravityPath, type: 'json-permissions', content: projectAntigravityPerms },
    { agent: 'cursor', target: 'Cursor (User)', path: userCursorPath, type: 'json-permissions', content: userCursorPerms },
    { agent: 'cursor', target: 'Cursor (Project)', path: projectCursorPath, type: 'json-permissions', content: projectCursorPerms },
    { agent: 'opencode', target: 'OpenCode (User)', path: userOpenCodePath, type: 'json-permission', content: userOpenCodePerms },
    { agent: 'opencode', target: 'OpenCode (Project)', path: projectOpenCodePath, type: 'json-permission', content: projectOpenCodePerms },
  ];

  // Filter out agents that read canonical .agents natively
  const fileActions = candidateActions.filter(item => {
    if (!requiresNativeCompiler(item.agent)) {
      console.log(`  [SKIPPED] ${item.target}: Agent '${item.agent}' natively reads from .agents/`);
      return false;
    }
    return true;
  });

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
      } else if (item.type === 'json-permissions') {
        const res = updateJsonSection(item.path, 'permissions', item.content, true);
        if (res.changed && !res.readOnly) {
          isDrifted = true;
          console.error(`  [DRIFT] Out of sync: ${item.path} (${item.target})`);
        }
      } else if (item.type === 'json-permission') {
        const res = updateJsonSection(item.path, 'permission', item.content, true);
        if (res.changed && !res.readOnly) {
          isDrifted = true;
          console.error(`  [DRIFT] Out of sync: ${item.path} (${item.target})`);
        }
      }
      if (isDrifted) driftedCount++;
    } else {
      let changed = false;
      if (item.type === 'text') {
        changed = writeIfChanged(item.path, item.content);
        console.log(`  [${changed ? 'UPDATED' : 'UP-TO-DATE'}] ${item.target} -> ${item.path}`);
      } else if (item.type === 'json-permissions') {
        const res = updateJsonSection(item.path, 'permissions', item.content, false);
        if (res.readOnly) {
          console.log(`  [READ-ONLY (SKIPPED)] ${item.target} -> ${item.path} (managed externally)`);
        } else {
          console.log(`  [${res.changed ? 'UPDATED' : 'UP-TO-DATE'}] ${item.target} -> ${item.path}`);
        }
      } else if (item.type === 'json-permission') {
        const res = updateJsonSection(item.path, 'permission', item.content, false);
        if (res.readOnly) {
          console.log(`  [READ-ONLY (SKIPPED)] ${item.target} -> ${item.path} (managed externally)`);
        } else {
          console.log(`  [${res.changed ? 'UPDATED' : 'UP-TO-DATE'}] ${item.target} -> ${item.path}`);
        }
      }
    }
  }

  // 8. Synchronize .gitignore (only ignore pure permission files; remove broad directory ignores)
  const gitignoreRes = syncGitignore(projectRoot, isCheckMode);
  if (isCheckMode) {
    if (gitignoreRes.changed) {
      driftedCount++;
      console.error(`  [DRIFT] .gitignore has broad directory ignores or outdated permission entries! Run 'agent-permissions sync' (or 'npm run sync').`);
    }
  } else {
    if (gitignoreRes.changed) {
      console.log(`  [UPDATED] .gitignore -> synced pure permission file ignores (removed broad directory ignores)`);
    } else {
      console.log(`  [UP-TO-DATE] .gitignore`);
    }
  }

  if (isCheckMode && driftedCount > 0) {
    console.error(`\n[ERROR] Check failed: ${driftedCount} target file(s) are missing or drifted! Run 'agent-permissions sync' (or 'npm run sync').`);
    process.exit(1);
  }

  // 8. Validate with Codex execpolicy check
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
    { cmd: ['agent-permissions', 'test'], expected: 'allow', desc: 'Project allow: agent-permissions test' },
    { cmd: ['agent-permissions', 'check'], expected: 'allow', desc: 'Project pattern: agent-permissions check' },
    { cmd: ['npx', 'agent-permissions', 'test'], expected: 'allow', desc: 'Project pattern: npx agent-permissions test' },
    { cmd: ['npx', '.', 'test'], expected: 'allow', desc: 'Project pattern: npx . test' },
    { cmd: ['./bin/agent-permissions', 'test'], expected: 'allow', desc: 'Project pattern: ./bin/agent-permissions test' },
    { cmd: ['node', '--test'], expected: 'allow', desc: 'Project allow: node --test' },
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
