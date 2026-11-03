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
  const r1 = parseCanonicalRule('Bash(git status)');
  assert.equal(r1.tool, 'Bash');
  assert.equal(r1.pattern, 'git status');

  const r2 = parseCanonicalRule('Write(/tmp/*)');
  assert.equal(r2.tool, 'Write');
  assert.equal(r2.pattern, '/tmp/*');

  const r3 = parseCanonicalRule('Read(/etc/hosts)');
  assert.equal(r3.tool, 'Read');
  assert.equal(r3.pattern, '/etc/hosts');

  assert.throws(() => parseCanonicalRule('invalid-rule-syntax'), /Invalid canonical rule syntax/);
  assert.throws(() => parseCanonicalRule(123), /Rule must be a string/);
});

test('2. Unknown or unrepresentable rules fail loudly', () => {
  // Unknown tool
  assert.throws(() => {
    validatePermissionSet({ allow: ['CustomTool(xyz)'] }, 'dummy.yml');
  }, /Unsupported tool 'CustomTool'/);

  // Broad arbitrary-code executor in allow
  const executors = ['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'just', 'make', 'npm run'];
  for (const exe of executors) {
    assert.throws(() => {
      validatePermissionSet({ allow: [`Bash(${exe})`] }, 'dummy.yml');
    }, /Security violation: Broad arbitrary-code executor/);
  }

  // Non-bash deny rule in Codex fails loudly
  assert.throws(() => {
    compileCodexRules({ allow: [], deny: ['Read(/etc/shadow)'], ask: [] }, 'test');
  }, /Codex execpolicy cannot faithfully represent non-Bash deny rule/);
});

test('3. Company baseline deny cannot be weakened by project allow', () => {
  const baseline = {
    allow: ['Bash(pwd)'],
    deny: ['Bash(sudo)', 'Bash(sudo:*)', 'Bash(su:*)'],
    ask: []
  };

  const maliciousProject = {
    allow: ['Bash(sudo true)'],
    deny: [],
    ask: []
  };

  assert.throws(() => {
    verifyNoDenyWeakening(baseline, maliciousProject);
  }, /Security violation: Project rule 'Bash\(sudo true\)' attempts to allow command denied by baseline rule/);

  const maliciousProject2 = {
    allow: ['Bash(su - admin)'],
    deny: [],
    ask: []
  };

  assert.throws(() => {
    verifyNoDenyWeakening(baseline, maliciousProject2);
  }, /Security violation: Project rule 'Bash\(su - admin\)' attempts to allow command denied by baseline rule/);
});

test('4. Codex execpolicy evaluation: Expected allows and expected denies', () => {
  const homeDir = os.homedir();
  const projectRoot = process.cwd();
  const userCodex = path.join(homeDir, '.codex', 'rules', 'generated-agents-policy.rules');
  const projectCodex = path.join(projectRoot, '.codex', 'rules', 'generated-agents-policy.rules');

  assert.ok(fs.existsSync(userCodex), 'User Codex rules must exist');
  assert.ok(fs.existsSync(projectCodex), 'Project Codex rules must exist');

  const rulePaths = [userCodex, projectCodex];

  // Baseline allows
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'status']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'diff']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'log']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'show']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['git', 'branch', '--show-current']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['pwd']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['rg', 'pattern']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['grep', 'pattern']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['head', 'file']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['tail', 'file']), 'allow');

  // Project allows
  assert.equal(checkCodexPolicy(rulePaths, ['just', 'test']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['just', 'agent-permissions-sync']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['just', 'agent-permissions-check']), 'allow');
  assert.equal(checkCodexPolicy(rulePaths, ['node', '--test']), 'allow');

  // Baseline hard denies
  assert.equal(checkCodexPolicy(rulePaths, ['sudo', 'true']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['sudo', 'rm', '-rf', '/']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['su']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['su', '-']), 'forbidden');
  assert.equal(checkCodexPolicy(rulePaths, ['doas', 'ls']), 'forbidden');
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
`);

  fs.writeFileSync(projRulesFile, `
prefix_rule(
    pattern = ["sudo"],
    decision = "allow",
    justification = "Project attempt to allow",
)
`);

  // Codex evaluates both: stricter decision (forbidden) must win
  const decision = checkCodexPolicy([baseRulesFile, projRulesFile], ['sudo', 'cat', '/etc/shadow']);
  assert.equal(decision, 'forbidden');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('6. Generation is deterministic and idempotent', () => {
  const policy = {
    allow: ['Bash(git status)', 'Bash(git diff)', 'Bash(pwd)'],
    deny: ['Bash(sudo)', 'Bash(su:*)'],
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
  const decision1 = checkCodexPolicy(rulePaths, ['bash', '-c', 'git status']);
  assert.equal(decision1, 'no-match');

  const decision2 = checkCodexPolicy(rulePaths, ['python3', '-c', 'print(1)']);
  assert.equal(decision2, 'no-match');
});
