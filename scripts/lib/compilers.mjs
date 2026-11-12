/**
 * Canonical Permission Policy Compilers
 * Compiles canonical rules into native configuration formats for:
 *   - Codex (Starlark prefix_rule)
 *   - Claude (permissions JSON block)
 *   - Antigravity (command(...) permissions JSON block)
 */

import { parseCanonicalRule } from './parser.mjs';

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
