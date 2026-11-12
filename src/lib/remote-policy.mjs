/**
 * Remote Company Policy Delivery & Forced Hook Management
 *
 * Supports fetching company baselines via HTTPS endpoints (webpage, CDN, GitHub raw, corporate intranet),
 * local caching for offline resilience, and forced agent SessionStart hooks for autonomous protection.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePolicyYaml } from './parser.mjs';
import { validatePermissionSet } from './validator.mjs';

/**
 * Resolves the remote company policy URL from CLI options, environment variables, or config files
 */
export function resolveRemoteBaselineUrl(options = {}, projectRoot = process.cwd(), homeDir = os.homedir()) {
  // 1. Direct CLI argument
  if (options.remoteUrl) {
    return options.remoteUrl;
  }

  // 2. Environment variables
  if (process.env.COMPANY_PERMISSIONS_URL) {
    return process.env.COMPANY_PERMISSIONS_URL.trim();
  }
  if (process.env.AGENT_PERMISSIONS_URL) {
    return process.env.AGENT_PERMISSIONS_URL.trim();
  }

  // 3. Project-level config: <repo>/.agents/config.json
  const projectConfigPath = path.join(projectRoot, '.agents', 'config.json');
  if (fs.existsSync(projectConfigPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
      if (cfg.remoteBaselineUrl || cfg.companyPermissionsUrl) {
        return (cfg.remoteBaselineUrl || cfg.companyPermissionsUrl).trim();
      }
    } catch {}
  }

  // 4. User/Global config: ~/.agents/config.json
  const userConfigPath = path.join(homeDir, '.agents', 'config.json');
  if (fs.existsSync(userConfigPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
      if (cfg.remoteBaselineUrl || cfg.companyPermissionsUrl) {
        return (cfg.remoteBaselineUrl || cfg.companyPermissionsUrl).trim();
      }
    } catch {}
  }

  return null;
}

/**
 * Fetches a remote policy from an HTTPS URL with offline local caching
 */
export async function fetchRemotePolicy(url, cacheDir = path.join(os.homedir(), '.agents', 'cache')) {
  if (!url) {
    throw new Error('Remote policy URL must be specified');
  }

  const cacheFile = path.join(cacheDir, 'company-remote-baseline.yml');
  let rawContent = null;
  let fromCache = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'agent-cli-permissions/0.1.0',
        'Accept': 'text/yaml, text/plain, application/json, */*'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    rawContent = await res.text();

    // Cache to disk
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, rawContent, 'utf8');
  } catch (err) {
    // If network fails, check if we have a cached version
    if (fs.existsSync(cacheFile)) {
      rawContent = fs.readFileSync(cacheFile, 'utf8');
      fromCache = true;
    } else {
      throw new Error(`Failed to fetch remote policy from '${url}': ${err.message}`);
    }
  }

  const parsed = parsePolicyYaml(rawContent);
  if (!parsed) {
    throw new Error(`Remote policy from '${url}' could not be parsed as valid YAML or JSON`);
  }

  validatePermissionSet(parsed, url);

  return {
    name: parsed.name || 'company-remote-baseline',
    allow: parsed.allow || [],
    deny: parsed.deny || [],
    ask: parsed.ask || [],
    sourceUrl: url,
    fromCache,
    cacheFile
  };
}

/**
 * Merges a local directory baseline with a remote policy
 */
export function mergePolicies(localBaseline, remotePolicy) {
  if (!remotePolicy) return localBaseline;

  const allowSet = new Set(localBaseline.allow || []);
  const denySet = new Set(localBaseline.deny || []);
  const askSet = new Set(localBaseline.ask || []);
  const files = [...(localBaseline.files || [])];

  (remotePolicy.allow || []).forEach(r => allowSet.add(r));
  (remotePolicy.deny || []).forEach(r => denySet.add(r));
  (remotePolicy.ask || []).forEach(r => askSet.add(r));
  files.push(`remote:${remotePolicy.name}${remotePolicy.fromCache ? ' (cached)' : ''}`);

  return {
    name: localBaseline.name || 'baseline',
    allow: Array.from(allowSet).sort(),
    deny: Array.from(denySet).sort(),
    ask: Array.from(askSet).sort(),
    files: Array.from(new Set(files))
  };
}

/**
 * Installs an automatic SessionStart hook in Claude Code settings
 * guaranteeing policies are refreshed whenever an agent session starts.
 */
export function installSessionStartHook({ global = false, projectRoot = process.cwd(), homeDir = os.homedir() } = {}) {
  const targetDir = global ? path.join(homeDir, '.claude') : path.join(projectRoot, '.claude');
  const targetFile = path.join(targetDir, 'settings.json');

  fs.mkdirSync(targetDir, { recursive: true });

  let settings = {};
  if (fs.existsSync(targetFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    } catch {}
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.SessionStart)) {
    settings.hooks.SessionStart = [];
  }

  const hookCommand = 'npx --yes agent-cli-permissions sync --silent';
  const existingIdx = settings.hooks.SessionStart.findIndex(h =>
    h && typeof h.command === 'string' && (h.command.includes('agent-cli-permissions sync') || h.command.includes('agent-permissions sync'))
  );

  let updated = false;
  if (existingIdx === -1) {
    settings.hooks.SessionStart.push({ command: hookCommand });
    updated = true;
  }

  if (updated || !fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }

  return {
    targetFile,
    isGlobal: global,
    updated
  };
}

/**
 * Installs a Git pre-commit or post-checkout hook to force policy check
 */
export function installGitHook(projectRoot = process.cwd(), hookType = 'pre-commit') {
  const gitDir = path.join(projectRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    return { ok: false, message: `No .git directory found at ${projectRoot}` };
  }

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookFile = path.join(hooksDir, hookType);
  const hookScript = `#!/bin/sh\n# Forced policy compliance gate managed by agent-cli-permissions\nnpx --yes agent-cli-permissions check || exit 1\n`;

  let existing = '';
  if (fs.existsSync(hookFile)) {
    existing = fs.readFileSync(hookFile, 'utf8');
    if (existing.includes('agent-cli-permissions check') || existing.includes('agent-permissions check')) {
      return { ok: true, hookFile, updated: false, message: `Hook '${hookType}' is already configured.` };
    }
  }

  const newContent = existing ? `${existing.trim()}\n\n${hookScript}` : hookScript;
  fs.writeFileSync(hookFile, newContent, { encoding: 'utf8', mode: 0o755 });

  return {
    ok: true,
    hookFile,
    updated: true,
    message: `Installed ${hookType} hook at ${hookFile}`
  };
}
