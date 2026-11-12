/**
 * Canonical Permission Policy Validator
 * Security rules, blanket-executor guards, directory loaders, and layering verifiers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parsePolicyYaml, parseCanonicalRule } from './parser.mjs';

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
    const parsed = parsePolicyYaml(content);
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
