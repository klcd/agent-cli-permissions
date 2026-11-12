import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseCanonicalRule,
  validatePermissionSet,
  loadPolicyDirectory,
  verifyNoDenyWeakening,
  compileCodexRules,
  compileClaudePermissions,
  compileAntigravityPermissions,
  checkCodexPolicy,
} from '../scripts/sync-permissions.mjs';

test('1. Canonical rule parsing works for valid tools and patterns', () => {
  const r1 = parseCanonicalRule('Bash(git status:*)');
  assert.equal(r1.tool, 'Bash');
  assert.equal(r1.pattern, 'git status:*');

  const r2 = parseCanonicalRule('Write(/tmp/*)');
  assert.equal(r2.tool, 'Write');
  assert.equal(r2.pattern, '/tmp/*');

  const r3 = parseCanonicalRule('Read(/etc/hosts)');
  assert.equal(r3.tool, 'Read');
  assert.equal(r3.pattern, '/etc/hosts');

  assert.throws(() => parseCanonicalRule('invalid-rule-syntax'), /Invalid canonical rule syntax/);
  assert.throws(() => parseCanonicalRule(123), /Rule must be a string/);
});

test('2. Broad arbitrary-code executors and un-scoped sensitive tools fail loudly', () => {
  // Unknown tool
  assert.throws(() => {
    validatePermissionSet({ allow: ['CustomTool(xyz)'] }, 'dummy.yml');
  }, /Unsupported tool 'CustomTool'/);

  // Broad executors and un-scoped tools in allow list
  const executors = [
    'bash', 'sh', 'zsh', 'python', 'python3', 'node', 'just', 'make',
    'docker', 'podman', 'kubectl', 'helm', 'terraform', 'tofu', 'nix'
  ];
  for (const exe of executors) {
    assert.throws(() => {
      validatePermissionSet({ allow: [`Bash(${exe})`] }, 'dummy.yml');
    }, /Security violation: Broad arbitrary-code executor or un-scoped tool/);

    assert.throws(() => {
      validatePermissionSet({ allow: [`Bash(${exe}:*)`] }, 'dummy.yml');
    }, /Security violation: Broad arbitrary-code executor or un-scoped tool/);
  }

  // Non-bash deny rule in Codex fails loudly
  assert.throws(() => {
    compileCodexRules({ allow: [], deny: ['Read(/etc/shadow)'], ask: [] }, 'test');
  }, /Codex execpolicy cannot faithfully represent non-Bash deny rule/);
});

test('3. Company baseline deny cannot be weakened by project allow', () => {
  const baseline = {
    allow: ['Bash(pwd)'],
    deny: [
      'Bash(sudo)', 'Bash(sudo:*)', 'Bash(su:*)',
      'Bash(shutdown:*)', 'Bash(rm -rf /)',
      'Bash(docker run --privileged:*)', 'Bash(kubectl delete:*)'
    ],
    ask: []
  };

  const maliciousCases = [
    'Bash(sudo true)',
    'Bash(sudo ls:*)',
    'Bash(su - admin)',
    'Bash(rm -rf /)',
    'Bash(docker run --privileged:*)',
    'Bash(kubectl delete pods)'
  ];

  for (const rule of maliciousCases) {
    assert.throws(() => {
      verifyNoDenyWeakening(baseline, { allow: [rule], deny: [], ask: [] });
    }, /Security violation: Project rule .* attempts to allow command denied by baseline rule/);
  }
});

test('4. Codex execpolicy evaluation: Expected allows and expected denies with patterns', () => {
  const homeDir = os.homedir();
  const projectRoot = process.cwd();
  const userCodex = path.join(homeDir, '.codex', 'rules', 'generated-agents-policy.rules');
  const projectCodex = path.join(projectRoot, '.codex', 'rules', 'generated-agents-policy.rules');

  assert.ok(fs.existsSync(userCodex), 'User Codex rules must exist');
  assert.ok(fs.existsSync(projectCodex), 'Project Codex rules must exist');

  const rulePaths = [userCodex, projectCodex];

  // Baseline inspection with argument patterns
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'status']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'status', '--short']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'diff']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'diff', '--staged', 'HEAD']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'log', '-n', '5', '--oneline']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'branch', '-a']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'rev-parse', 'HEAD']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['pwd']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['whoami']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['date', '+%s']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['rg', '-i', 'TODO', 'src/']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['grep', '-rn', 'main', '.']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['head', '-n', '20', 'file']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['jq', '-r', '.name', 'package.json']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['file', 'README.md']), 'allow');

  // Infrastructure scoped allows with patterns
  assert.equal(checkCodexPolicy(rulePaths, ['docker', 'ps']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['docker', 'ps', '-a']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['docker', 'images']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['docker', 'inspect', 'my-container']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['kubectl', 'get', 'pods', '-n', 'default']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['kubectl', 'describe', 'pod', 'my-pod']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['helm', 'list', '-A']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['terraform', 'validate']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['tofu', 'fmt', '-check']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['nix', 'flake', 'check']), 'allow');

  // Project workflow allows with patterns
  assert.equal(checkCodexPolicy(rulePaths, ['just', 'test']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['just', 'test', 'tests/permissions.test.mjs']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'add', '-A']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'commit', '-m', 'chore: update']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'checkout', '-b', 'feature-branch']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'stash', 'pop']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['node', '--test']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['node', '--test', 'tests/*.mjs']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['npm', 'test']), 'allow');

  // Baseline hard denies: Privilege escalation
  assert.equal(checkCodexPolicy(rulePaths, ['sudo', 'true']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['sudo', 'rm', '-rf', '/']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['su']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['su', '-']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['doas', 'ls']), 'forbidden');

  // Baseline hard denies: Disk & system destruction
  assert.equal(checkCodexPolicy(rulePaths, ['dd', 'if=/dev/zero', 'of=/dev/sda']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['mkfs', '/dev/sda1']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['fdisk', '/dev/sda']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['shutdown', '-h', 'now']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['reboot']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['rm', '-rf', '/']), 'forbidden');

  // Infrastructure hard denies
  assert.equal(checkCodexPolicy(rulePaths, ['docker', 'run', '--privileged', 'alpine']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['kubectl', 'delete', 'pod', 'critical-pod']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['terraform', 'destroy', '-auto-approve']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['tofu', 'destroy']), 'forbidden');
});

test('5. Codex execpolicy conflict resolution: forbidden strictly overrides allow', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execpolicy-test-'));
  const baseRulesFile = path.join(tmpDir, 'baseline.rules');
  const projRulesFile = path.join(tmpDir, 'project.rules');

  fs.writeFileSync(baseRulesFile, `
prefix_rule(
    pattern = ["sudo"],
    decision = "forbidden",
    justification = "Company deny",
)
prefix_rule(
    pattern = ["kubectl", "delete"],
    decision = "forbidden",
    justification = "Company deny",
)
`);

  fs.writeFileSync(projRulesFile, `
prefix_rule(
    pattern = ["sudo"],
    decision = "allow",
    justification = "Project attempt to allow",
)
prefix_rule(
    pattern = ["kubectl", "delete"],
    decision = "allow",
    justification = "Project attempt to allow",
)
`);

  // Codex evaluates both: stricter decision (forbidden) must win
  assert.equal(checkCodexPolicy([baseRulesFile, projRulesFile], ['sudo', 'cat', '/etc/shadow']), 'forbidden');
  assert.equal(checkCodexPolicy([baseRulesFile, projRulesFile], ['kubectl', 'delete', 'pod', 'prod']), 'forbidden');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('6. Generation is deterministic and idempotent', () => {
  const policy = {
    allow: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(docker ps:*)', 'Bash(rg:*)'],
    deny: ['Bash(sudo:*)', 'Bash(kubectl delete:*)'],
    ask: []
  };

  const output1 = compileCodexRules(policy, 'test');
  const output2 = compileCodexRules(policy, 'test');
  assert.equal(output1, output2, 'Codex compilation must be byte-for-byte identical');

  const claude1 = JSON.stringify(compileClaudePermissions(policy));
  const claude2 = JSON.stringify(compileClaudePermissions(policy));
  assert.equal(claude1, claude2, 'Claude compilation must be byte-for-byte identical');

  const agy1 = JSON.stringify(compileAntigravityPermissions(policy));
  const agy2 = JSON.stringify(compileAntigravityPermissions(policy));
  assert.equal(agy1, agy2, 'Antigravity compilation must be byte-for-byte identical');
});

test('7. Unauthorized executor wrapping is not permitted', () => {
  const homeDir = os.homedir();
  const projectRoot = process.cwd();
  const rulePaths = [
    path.join(homeDir, '.codex', 'rules', 'generated-agents-policy.rules'),
    path.join(projectRoot, '.codex', 'rules', 'generated-agents-policy.rules')
  ];

  // Shell running arbitrary script
  assert.equal(checkCodexPolicy(rulePaths, ['bash', '-c', 'git status']), 'no-match');
  assert.equal(checkCodexPolicy(rulePaths, ['python3', '-c', 'print(1)']), 'no-match');
});

test('8. Modular components in lib/*.mjs can be imported directly', async () => {
  const parser = await import('../scripts/lib/parser.mjs');
  const validator = await import('../scripts/lib/validator.mjs');
  const compilers = await import('../scripts/lib/compilers.mjs');

  assert.equal(typeof parser.parsePolicyYaml, 'function');
  assert.equal(typeof parser.parseCanonicalRule, 'function');
  assert.equal(typeof validator.validatePermissionSet, 'function');
  assert.equal(typeof validator.verifyNoDenyWeakening, 'function');
  assert.equal(typeof compilers.compileCodexRules, 'function');
  assert.equal(typeof compilers.compileClaudePermissions, 'function');
  assert.equal(typeof compilers.compileAntigravityPermissions, 'function');

  // Verify pure parser behavior via direct sub-module
  const parsed = parser.parsePolicyYaml('name: test\nallow:\n  - "Bash(pwd)"');
  assert.equal(parsed.name, 'test');
  assert.deepEqual(parsed.allow, ['Bash(pwd)']);
});

test('9. Compilers for common other agents (Cursor, OpenCode, Grok, Kimi, Droid)', async () => {
  const {
    compileCursorPermissions,
    compileOpenCodePermissions,
    compileGrokPermissions,
    compileKimiPermissions,
    compileDroidPermissions,
  } = await import('../scripts/lib/compilers.mjs');

  const policy = {
    allow: ['Bash(git status:*)', 'Bash(pwd)', 'WebSearch(docs)'],
    deny: ['Bash(sudo:*)', 'Bash(rm -rf /)'],
    ask: ['Bash(terraform apply:*)']
  };

  // Cursor: maps Bash -> Shell, WebSearch -> WebFetch
  const cursor = compileCursorPermissions(policy);
  assert.ok(cursor.allow.includes('Shell(git status:*)'));
  assert.ok(cursor.allow.includes('WebFetch(docs)'));
  assert.ok(cursor.deny.includes('Shell(sudo:*)'));
  assert.ok(cursor.ask.includes('Shell(terraform apply:*)'));

  // OpenCode: maps to permission.bash { pattern: action }
  const opencode = compileOpenCodePermissions(policy);
  assert.equal(opencode.permission.bash['git status:*'], 'allow');
  assert.equal(opencode.permission.bash['pwd'], 'allow');
  assert.equal(opencode.permission.bash['sudo:*'], 'deny');
  assert.equal(opencode.permission.bash['terraform apply:*'], 'ask');

  // Grok: maps to permission.rules [{ tool, pattern, action }]
  const grok = compileGrokPermissions(policy);
  assert.ok(grok.permission.rules.some(r => r.tool === 'bash' && r.pattern === 'git status:*' && r.action === 'allow'));
  assert.ok(grok.permission.rules.some(r => r.tool === 'bash' && r.pattern === 'sudo:*' && r.action === 'deny'));

  // Kimi: TOML generation
  const kimi = compileKimiPermissions(policy, 'test');
  assert.ok(kimi.includes('[permission]'));
  assert.ok(kimi.includes('"allow"'));
  assert.ok(kimi.includes('"deny"'));

  // Droid: commandAllowlist & commandDenylist
  const droid = compileDroidPermissions(policy);
  assert.ok(droid.commandAllowlist.includes('git status *'));
  assert.ok(droid.commandDenylist.includes('sudo *'));
});

test('10. Agents reading .agents natively are skipped from redundant compilation', async () => {
  const {
    AGENTS_READING_CANONICAL_DIRECTLY,
    requiresNativeCompiler
  } = await import('../scripts/lib/compilers.mjs');

  assert.equal(requiresNativeCompiler('claude'), true);
  assert.equal(requiresNativeCompiler('codex'), true);
  assert.equal(requiresNativeCompiler('cursor'), true);
  assert.equal(requiresNativeCompiler('opencode'), true);

  // Register a mock native agent that reads .agents directly
  AGENTS_READING_CANONICAL_DIRECTLY.add('mock-native-agent');
  try {
    assert.equal(requiresNativeCompiler('mock-native-agent'), false);
  } finally {
    AGENTS_READING_CANONICAL_DIRECTLY.delete('mock-native-agent');
  }
});
