/**
 * Gitignore Manager for Unified Coding-Agent Permissions
 *
 * Ensures:
 * 1. Entire agent directories (.claude/, .codex/, .gemini/, etc.) are NEVER ignored,
 *    allowing skills, commands, custom rules, and non-permission files to be tracked.
 * 2. Dedicated generated rule files (.codex/rules/generated-agents-policy.rules) and
 *    local-only settings (.claude/settings.local.json) are always gitignored.
 * 3. Settings files (.claude/settings.json, .gemini/settings.json, .cursor/cli-config.json,
 *    opencode.json) are ONLY gitignored if they are pure permission files (empty of other
 *    configs like hooks, MCP servers, editor settings before adding permissions).
 *    If a settings file contains other configs, it is NOT gitignored.
 */

import fs from 'node:fs';
import path from 'node:path';

// Agent directories that must never be broadly ignored
export const FORBIDDEN_DIRECTORY_IGNORES = [
  '.claude/',
  '.claude',
  '.codex/',
  '.codex',
  '.gemini/',
  '.gemini',
  '.cursor/',
  '.cursor',
  '.grok/',
  '.grok',
  '.kimi-code/',
  '.kimi-code',
  '.factory/',
  '.factory',
];

/**
 * Strips comments from JSON/JSONC text
 */
function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Checks if a settings file exists and contains ONLY permission configuration
 * (i.e. was empty of other configs such as hooks, MCP servers, editor preferences).
 */
export function isPurePermissionsFile(filePath) {
  if (!fs.existsSync(filePath)) return true; // If absent, it will be pure permissions once created
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const cleaned = stripComments(raw).trim();
    if (!cleaned || cleaned === '{}') return true;
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;

    // Allowed permission keys across agent schemas
    const permissionKeys = new Set(['permissions', 'permission', 'commandAllowlist', 'commandDenylist']);
    const nonPermissionKeys = keys.filter(k => !permissionKeys.has(k));

    return nonPermissionKeys.length === 0;
  } catch {
    return false;
  }
}

/**
 * Determines the list of generated permission files that should be ignored in git
 */
export function getExpectedGitignoreEntries(projectRoot) {
  const entries = [];

  // 1. Dedicated generated rule and local files (always ignored)
  entries.push('.codex/rules/generated-agents-policy.rules');
  entries.push('.claude/settings.local.json');

  // 2. Settings files that may contain other configs
  const candidateFiles = [
    { rel: '.claude/settings.json' },
    { rel: '.gemini/settings.json' },
    { rel: '.cursor/cli-config.json' },
    { rel: 'opencode.json' },
  ];

  for (const candidate of candidateFiles) {
    const fullPath = path.join(projectRoot, candidate.rel);
    // Only ignore if the file is purely for permissions (no hooks, MCP, or other configs)
    if (isPurePermissionsFile(fullPath)) {
      entries.push(candidate.rel);
    }
  }

  return entries.sort();
}

/**
 * Updates .gitignore to ensure only pure generated permission files are ignored,
 * removing any broad directory ignores.
 */
export function syncGitignore(projectRoot, checkOnly = false) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
  }

  const lines = content.split(/\r?\n/);
  const forbiddenSet = new Set(FORBIDDEN_DIRECTORY_IGNORES.map(d => d.replace(/\/$/, '')));

  // Filter out forbidden broad directory ignores
  let cleanedLines = lines.filter(line => {
    const trimmed = line.trim();
    const cleanDir = trimmed.replace(/\/$/, '');
    return !forbiddenSet.has(cleanDir);
  });

  const expectedEntries = getExpectedGitignoreEntries(projectRoot);

  // Check which expected entries are present
  const sectionHeader = '# Generated native agent permission files (only ignored if purely permissions)';
  const currentText = cleanedLines.join('\n');

  // Collect all managed agent permission entries
  const allPossibleAgentEntries = new Set([
    '.codex/rules/generated-agents-policy.rules',
    '.claude/settings.local.json',
    '.claude/settings.json',
    '.gemini/settings.json',
    '.cursor/cli-config.json',
    'opencode.json',
    'opencode.jsonc',
  ]);

  // Remove stale or forbidden agent entries
  const finalLines = [];
  let inManagedSection = false;

  for (const line of cleanedLines) {
    const trimmed = line.trim();
    if (trimmed === sectionHeader) {
      inManagedSection = true;
      continue;
    }
    if (allPossibleAgentEntries.has(trimmed)) {
      // Managed entry, will be rebuilt
      continue;
    }
    if (trimmed.startsWith('# Generated native agent configuration folders')) {
      // Old section header
      continue;
    }
    finalLines.push(line);
  }

  // Trim trailing empty lines
  while (finalLines.length > 0 && finalLines[finalLines.length - 1].trim() === '') {
    finalLines.pop();
  }

  // Append clean managed entries
  finalLines.push('');
  finalLines.push(sectionHeader);
  for (const entry of expectedEntries) {
    finalLines.push(entry);
  }
  finalLines.push('');

  const newContent = finalLines.join('\n');

  if (checkOnly) {
    return {
      changed: content !== newContent,
      current: content,
      expected: newContent,
    };
  }

  if (content !== newContent) {
    fs.writeFileSync(gitignorePath, newContent, 'utf8');
    return { changed: true };
  }

  return { changed: false };
}
