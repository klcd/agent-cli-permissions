/**
 * Canonical Permission Policy Compilers
 *
 * Compiles canonical rules into native configuration formats for:
 *   - Codex (Starlark prefix_rule)
 *   - Claude (permissions JSON block)
 *   - Antigravity (command(...) permissions JSON block)
 *   - Cursor (Shell(...) permissions JSON block)
 *   - OpenCode (permission.bash key-value mapping)
 *   - Grok (permission.rules tool/action list)
 *   - Kimi (TOML [permission] rules table)
 *   - Droid (commandAllowlist & commandDenylist)
 *
 * Agents that natively read from .agents/ and use generic rules
 * are recorded in AGENTS_READING_CANONICAL_DIRECTLY and do not require compilation.
 */

import { parseCanonicalRule } from './parser.mjs';

/**
 * Registry of agents that natively read from .agents/ directly.
 * If an agent supports .agents/permissions/ natively, add it here to skip compilation.
 */
export const AGENTS_READING_CANONICAL_DIRECTLY = new Set([
  // Any agent with native .agents/ support goes here
]);

/**
 * Checks whether an agent needs a native compiler or can read .agents natively.
 */
export function requiresNativeCompiler(agentId) {
  return !AGENTS_READING_CANONICAL_DIRECTLY.has(agentId);
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
 * Compiles canonical rules into Cursor native permissions JSON block (Shell syntax)
 */
export function compileCursorPermissions(policy) {
  const mapRule = (perm) => {
    if (perm === 'Bash' || perm.startsWith('Bash(')) {
      return perm.replace(/^Bash/, 'Shell');
    }
    if (perm.startsWith('WebSearch(')) {
      return perm.replace(/^WebSearch/, 'WebFetch');
    }
    if (perm === 'Edit' || perm.startsWith('Edit(')) {
      return perm.replace(/^Edit/, 'Write');
    }
    return perm;
  };

  const allow = Array.from(new Set(policy.allow.map(mapRule))).sort();
  const deny = Array.from(new Set(policy.deny.map(mapRule))).sort();
  const ask = Array.from(new Set((policy.ask || []).map(mapRule))).sort();

  const permissions = { allow, deny };
  if (ask.length > 0) {
    permissions.ask = ask;
  }
  return permissions;
}

/**
 * Compiles canonical rules into OpenCode native permission block (permission.bash)
 */
export function compileOpenCodePermissions(policy) {
  const bash = {};

  // Allows first
  for (const r of policy.allow) {
    const parsed = parseCanonicalRule(r);
    if (parsed.tool === 'Bash') {
      bash[parsed.pattern] = 'allow';
    }
  }

  // Asks second
  for (const r of (policy.ask || [])) {
    const parsed = parseCanonicalRule(r);
    if (parsed.tool === 'Bash') {
      bash[parsed.pattern] = 'ask';
    }
  }

  // Denies last (highest precedence: deny overwrites allow/ask)
  for (const r of policy.deny) {
    const parsed = parseCanonicalRule(r);
    if (parsed.tool === 'Bash') {
      bash[parsed.pattern] = 'deny';
    }
  }

  return {
    permission: {
      bash
    }
  };
}

/**
 * Compiles canonical rules into Grok native permission format
 */
export function compileGrokPermissions(policy) {
  const rules = [];
  const seen = new Set();

  const add = (ruleStr, action) => {
    const parsed = parseCanonicalRule(ruleStr);
    const tool = parsed.tool.toLowerCase();
    const pattern = parsed.pattern;
    const key = `${tool}:${pattern}:${action}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ tool, pattern, action });
  };

  for (const r of policy.deny) add(r, 'deny');
  for (const r of (policy.ask || [])) add(r, 'ask');
  for (const r of policy.allow) add(r, 'allow');

  return {
    permission: {
      rules
    }
  };
}

/**
 * Compiles canonical rules into Kimi native TOML format
 */
export function compileKimiPermissions(policy, sourceDescription) {
  const rules = [];
  for (const r of policy.deny) {
    rules.push({ decision: 'deny', pattern: r });
  }
  for (const r of (policy.ask || [])) {
    rules.push({ decision: 'ask', pattern: r });
  }
  for (const r of policy.allow) {
    rules.push({ decision: 'allow', pattern: r });
  }

  let out = `# GENERATED FILE.\n# Source: ${sourceDescription}\n# Do not edit manually.\n\n[permission]\nrules = [\n`;
  for (const rule of rules) {
    out += `  { decision = ${JSON.stringify(rule.decision)}, pattern = ${JSON.stringify(rule.pattern)} },\n`;
  }
  out += `]\n`;
  return out;
}

/**
 * Compiles canonical rules into Droid native settings format
 */
export function compileDroidPermissions(policy) {
  const toDroid = (ruleStr) => {
    const parsed = parseCanonicalRule(ruleStr);
    if (parsed.tool !== 'Bash') return null;
    let p = parsed.pattern;
    if (p.endsWith(':*')) {
      p = p.slice(0, -2) + ' *';
    }
    return p;
  };

  const commandAllowlist = Array.from(new Set(policy.allow.map(toDroid).filter(Boolean))).sort();
  const commandDenylist = Array.from(new Set(policy.deny.map(toDroid).filter(Boolean))).sort();

  return {
    commandAllowlist,
    commandDenylist
  };
}
