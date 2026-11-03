#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import yaml from 'yaml';

// Blanket arbitrary code executors and sensitive tools that must never be broadly allowed
export const FORBIDDEN_BLANKET_EXECUTORS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'csh', 'tcsh', 'ksh',
  'python', 'python3', 'python2', 'node', 'bun', 'deno',
  'ruby', 'perl', 'php', 'env',
  'npm run', 'pnpm run', 'yarn run', 'bun run',
  'make', 'just',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'tofu', 'nix',
  'ssh', 'curl', 'wget'
]);

/**
 * Parses a canonical rule like "Bash(git status)" or "Write(/tmp/*)"
 */
export function parseCanonicalRule(ruleStr) {
  if (typeof ruleStr !== 'string') {
    throw new Error(`Rule must be a string, got: ${typeof ruleStr}`);
  }
  const match = ruleStr.trim().match(/^(\w+)\((.*)\)$/);
  if (!match) {
    throw new Error(`Invalid canonical rule syntax: '${ruleStr}'. Expected Format: 'Tool(pattern)' (e.g. 'Bash(git status)')`);
  }
  const tool = match[1];
  const pattern = match[2].trim();
  return { tool, pattern, raw: ruleStr };
}

/**
 * Validates a permission set object
 */
export function validatePermissionSet(set, filePath) {
  if (!set || typeof set !== 'object') {
    throw new Error(`Invalid permission file '${filePath}': must be a YAML object`);
  }
  const allowedTools = new Set(['Bash', 'Read', 'Write', 'WebSearch', 'WebFetch']);

  for (const listName of ['allow', 'deny', 'ask']) {
    const list = set[listName];
    if (!list) continue;
    if (!Array.isArray(list)) {
      throw new Error(`Invalid '${listName}' block in '${filePath}': must be an array`);
    }

    for (const rule of list) {
      const parsed = parseCanonicalRule(rule);
      if (!allowedTools.has(parsed.tool)) {
        throw new Error(`Unsupported tool '${parsed.tool}' in '${rule}' within '${filePath}'. Supported tools: ${Array.from(allowedTools).join(', ')}`);
      }

      if (parsed.tool === 'Bash' && listName === 'allow') {
        // Strip trailing :* or * to check the base command
        const normPattern = parsed.pattern.toLowerCase().replace(/:?\*$/, '').trim();
        if (FORBIDDEN_BLANKET_EXECUTORS.has(normPattern)) {
          throw new Error(`Security violation: Broad arbitrary-code executor or un-scoped tool '${rule}' in '${filePath}' is prohibited! Use specific subcommands.`);
        }
      }
    }
  }
}

/**
 * Reads all .yml/.yaml policy files from a directory
 */
export function loadPolicyDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return { name: path.basename(dirPath), allow: [], deny: [], ask: [], files: [] };
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const allows = new Set();
  const denies = new Set();
  const asks = new Set();
  const loadedFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

    const fullPath = path.join(dirPath, entry.name);
    const content = fs.readFileSync(fullPath, 'utf8');
    const parsed = yaml.parse(content);
    if (!parsed) continue;

    validatePermissionSet(parsed, fullPath);

    (parsed.allow || []).forEach(r => allows.add(r));
    (parsed.deny || []).forEach(r => denies.add(r));
    (parsed.ask || []).forEach(r => asks.add(r));
    loadedFiles.push(entry.name);
  }

  return {
    allow: Array.from(allows).sort(),
    deny: Array.from(denies).sort(),
    ask: Array.from(asks).sort(),
    files: loadedFiles.sort()
  };
}

/**
 * Checks that project rules cannot weaken or contradict baseline denies.
 */
export function verifyNoDenyWeakening(baselinePolicy, projectPolicy) {
  const baselineDenyPrefixes = baselinePolicy.deny.map(r => {
    const parsed = parseCanonicalRule(r);
    const cmd = parsed.pattern.replace(/:?\*$/, '').trim();
    return { raw: r, tokens: cmd.split(/\s+/).filter(Boolean) };
  });

  for (const allowRule of projectPolicy.allow) {
    const parsed = parseCanonicalRule(allowRule);
    if (parsed.tool !== 'Bash') continue;
    const cleanPattern = parsed.pattern.replace(/:?\*$/, '').trim();
    const allowTokens = cleanPattern.split(/\s+/).filter(Boolean);

    for (const bDeny of baselineDenyPrefixes) {
      if (allowTokens.length >= bDeny.tokens.length) {
        let matches = true;
        for (let i = 0; i < bDeny.tokens.length; i++) {
          if (allowTokens[i] !== bDeny.tokens[i]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          throw new Error(`Security violation: Project rule '${allowRule}' attempts to allow command denied by baseline rule '${bDeny.raw}'! Baseline denies cannot be weakened.`);
        }
      }
    }
  }
}

/**
 * Compiles canonical rules into Codex Starlark prefix_rule statements.
 */
export function compileCodexRules(policy, sourceDescription) {
  const rules = [];
  const seen = new Set();

  function addRule(ruleStr, decision, justification) {
    const parsed = parseCanonicalRule(ruleStr);
    if (parsed.tool !== 'Bash') {
      if (decision === 'forbidden') {
        throw new Error(`ERROR: Codex execpolicy cannot faithfully represent non-Bash deny rule '${ruleStr}'`);
      }
      return; // Codex execpolicy only evaluates command executions
    }

    const command = parsed.pattern.replace(/:?\*$/, '').trim();
    if (!command) return;
    const tokens = command.split(/\s+/).filter(Boolean);
    const patternStr = tokens.map(t => JSON.stringify(t)).join(', ');
    const key = `${decision}:${patternStr}`;

    if (seen.has(key)) return;
    seen.add(key);

    rules.push({
      key,
      tokens,
      decision,
      code: `prefix_rule(\n    pattern = [${patternStr}],\n    decision = "${decision}",\n    justification = "${justification}",\n)`
    });
  }

  // Denies first (highest precedence)
  for (const rule of policy.deny) {
    addRule(rule, 'forbidden', 'Forbidden by shared agent security policy');
  }

  // Asks second
  for (const rule of policy.ask) {
    addRule(rule, 'prompt', 'Requires approval by agent security policy');
  }

  // Allows third
  for (const rule of policy.allow) {
    addRule(rule, 'allow', `Allowed by ${sourceDescription}`);
  }

  // Sort rules deterministically: forbidden first, then prompt, then allow; then by token string
  const decisionOrder = { forbidden: 0, prompt: 1, allow: 2 };
  rules.sort((a, b) => {
    if (decisionOrder[a.decision] !== decisionOrder[b.decision]) {
      return decisionOrder[a.decision] - decisionOrder[b.decision];
    }
    return a.tokens.join(' ').localeCompare(b.tokens.join(' '));
  });

  const ruleTexts = rules.map(r => r.code);
  const header = `# GENERATED FILE.\n# Source: ${sourceDescription}\n# Do not edit manually.\n\n`;
  return header + (ruleTexts.length > 0 ? ruleTexts.join('\n\n') + '\n' : '# No rules generated.\n');
}

/**
 * Compiles canonical rules into Claude native permissions JSON block
 */
export function compileClaudePermissions(policy) {
  const allow = Array.from(new Set(policy.allow)).sort();
  const deny = Array.from(new Set(policy.deny)).sort();
  const ask = Array.from(new Set(policy.ask || [])).sort();

  const permissions = { allow, deny };
  if (ask.length > 0) {
    permissions.ask = ask;
  }
  return permissions;
}

/**
 * Compiles canonical rules into Antigravity native permissions JSON block
 */
export function compileAntigravityPermissions(policy) {
  const mapRule = (r) => {
    const parsed = parseCanonicalRule(r);
    if (parsed.tool === 'Bash') {
      let p = parsed.pattern;
      if (p.endsWith(':*')) {
        p = p.slice(0, -2) + ' *';
      }
      return `command(${p})`;
    }
    if (parsed.tool === 'Read') return `read_file(${parsed.pattern})`;
    if (parsed.tool === 'Write') return `write_file(${parsed.pattern})`;
    if (parsed.tool === 'WebFetch') return `read_url(${parsed.pattern})`;
    return null;
  };

  const allow = Array.from(new Set(policy.allow.map(mapRule).filter(Boolean))).sort();
  const deny = Array.from(new Set(policy.deny.map(mapRule).filter(Boolean))).sort();
  const ask = Array.from(new Set((policy.ask || []).map(mapRule).filter(Boolean))).sort();

  const permissions = { allow, deny };
  if (ask.length > 0) {
    permissions.ask = ask;
  }
  return permissions;
}

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
 * Main execution function
 */
export async function main(args = process.argv.slice(2)) {
  const isCheckMode = args.includes('--check') || args.includes('check');
  const projectRoot = process.cwd();
  const homeDir = os.homedir();

  console.log(`[Permission Sync] Running in ${isCheckMode ? 'CHECK' : 'SYNC'} mode...`);
  console.log(`[Permission Sync] Project root: ${projectRoot}`);

  // 1. Resolve canonical directories
  const baselineDir = path.join(homeDir, '.agents', 'permissions');
  const projectPermsDir = path.join(projectRoot, '.agents', 'permissions');

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

  // Also maintain ~/.agents/permissions/groups/*.yml for AGI CLI compatibility
  if (!isCheckMode && fs.existsSync(baselineDir)) {
    const groupsDir = path.join(baselineDir, 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    for (const f of baselinePolicy.files) {
      const src = path.join(baselineDir, f);
      const dst = path.join(groupsDir, f);
      fs.copyFileSync(src, dst);
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
