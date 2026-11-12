/**
 * Canonical Permission Policy Parser
 * Pure zero-dependency YAML and canonical rule syntax parser.
 */

/**
 * Lightweight, zero-dependency parser for our canonical permission YAML structure.
 * Supports:
 *   - comments (#)
 *   - top-level scalar keys: name, description, mode
 *   - list blocks: allow, deny, ask
 *   - single/double quoted strings
 */
export function parsePolicyYaml(text) {
  const result = {
    allow: [],
    deny: [],
    ask: [],
  };

  const lines = text.split(/\r?\n/);
  let currentKey = null;

  for (let line of lines) {
    // Strip comments unless inside quotes
    const commentIdx = line.indexOf('#');
    if (commentIdx !== -1) {
      const before = line.slice(0, commentIdx);
      const singleQuotes = (before.match(/'/g) || []).length;
      const doubleQuotes = (before.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        line = before;
      }
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for top-level scalar keys: "key: value" or list starts: "key:"
    const topMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (topMatch) {
      const key = topMatch[1];
      const val = topMatch[2].trim();
      if (key === 'allow' || key === 'deny' || key === 'ask') {
        currentKey = key;
        continue;
      } else {
        currentKey = null;
        let unquoted = val;
        if ((unquoted.startsWith('"') && unquoted.endsWith('"')) || (unquoted.startsWith("'") && unquoted.endsWith("'"))) {
          unquoted = unquoted.slice(1, -1);
        }
        result[key] = unquoted;
        continue;
      }
    }

    // Check for list item: "  - value"
    const itemMatch = line.match(/^\s*-\s+(.*)$/);
    if (itemMatch && currentKey) {
      let item = itemMatch[1].trim();
      if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
        item = item.slice(1, -1);
      }
      result[currentKey].push(item);
    }
  }
  return result;
}

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
