import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CliPermissionRule,
  NativeAgentSyncStatus,
  PermissionGroupSummary,
} from '../types.ts'

/** Format a canonical pattern like `git status:*` into a readable CLI command syntax. */
export function formatCliPattern(tool: string, pattern: string): { cliCommand: string; baseBinary: string } {
  if (tool !== 'Bash') {
    return {
      cliCommand: `${tool}(${pattern})`,
      baseBinary: tool.toLowerCase(),
    }
  }
  const trimmed = pattern.trim()
  const normalized = trimmed.endsWith(':*')
    ? `${trimmed.slice(0, -2)} [args...]`
    : trimmed.endsWith('*') && !trimmed.endsWith('/*')
      ? `${trimmed.slice(0, -1)}[args...]`
      : trimmed
  const firstToken = trimmed.replace(/:?\*$/, '').trim().split(/\s+/)[0] || trimmed
  return {
    cliCommand: normalized,
    baseBinary: firstToken,
  }
}

/** Parse YAML permission files (`name`, `description`, `allow`, `ask`, `deny`) without external deps. */
export function parsePermissionYaml(
  content: string,
  sourceFile: string,
  scope: 'global' | 'workspace'
): PermissionGroupSummary {
  let name = path.basename(sourceFile, path.extname(sourceFile))
  let description = ''
  let currentList: 'allow' | 'ask' | 'deny' | null = null
  const rules: CliPermissionRule[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue

    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
      currentList = null
      continue
    }
    const descMatch = /^description:\s*(.+)$/.exec(line)
    if (descMatch) {
      description = descMatch[1].trim().replace(/^['"]|['"]$/g, '')
      currentList = null
      continue
    }
    if (/^allow:\s*$/.test(line)) {
      currentList = 'allow'
      continue
    }
    if (/^ask:\s*$/.test(line)) {
      currentList = 'ask'
      continue
    }
    if (/^deny:\s*$/.test(line)) {
      currentList = 'deny'
      continue
    }

    if (currentList && line.startsWith('-')) {
      const item = line.slice(1).trim().replace(/^['"]|['"]$/g, '')
      const ruleMatch = /^(\w+)\((.*)\)$/.exec(item)
      const tool = ruleMatch ? ruleMatch[1] : 'Bash'
      const pattern = ruleMatch ? ruleMatch[2].trim() : item
      const { cliCommand, baseBinary } = formatCliPattern(tool, pattern)
      const groupDesc = description || `${scope === 'global' ? 'Global' : 'Workspace'} ${name} policy`
      const actionVerb =
        currentList === 'allow'
          ? 'Permits automatic execution without confirmation'
          : currentList === 'ask'
            ? 'Requires interactive user approval before execution'
            : 'Hard-blocks execution inside and outside the sandbox'
      const scopePath =
        scope === 'global'
          ? `~/.agents/permissions/${sourceFile}`
          : `.agents/permissions/${sourceFile}`
      rules.push({
        raw: item,
        tool,
        pattern,
        cliCommand,
        baseBinary,
        action: currentList,
        scope,
        groupName: name,
        groupDescription: groupDesc,
        sourceFile,
        explanation: `${actionVerb} for \`${cliCommand}\` under ${scope} policy "${name}" (${groupDesc}, defined in \`${scopePath}\`).`,
        compatibleAgents: ['claude', 'codex', 'antigravity'],
      })
    }
  }

  return {
    name,
    description: description || `${scope === 'global' ? 'Global' : 'Workspace'} ${name} policy`,
    scope,
    sourceFile,
    allowCount: rules.filter(r => r.action === 'allow').length,
    askCount: rules.filter(r => r.action === 'ask').length,
    denyCount: rules.filter(r => r.action === 'deny').length,
    rules,
  }
}

export function loadPermissionGroups(
  workspacePath: string,
  homeDir = os.homedir()
): PermissionGroupSummary[] {
  const groups: PermissionGroupSummary[] = []
  const loadDir = (dir: string, scope: 'global' | 'workspace') => {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
    for (const file of entries) {
      const fullPath = path.join(dir, file)
      try {
        if (!fs.statSync(fullPath).isFile()) continue
        const content = fs.readFileSync(fullPath, 'utf8')
        groups.push(parsePermissionYaml(content, file, scope))
      } catch {}
    }
  }

  loadDir(path.join(homeDir, '.agents', 'permissions'), 'global')
  loadDir(path.join(workspacePath, '.agents', 'permissions'), 'workspace')
  return groups
}

export function inspectNativeSync(workspacePath: string, homeDir = os.homedir()): NativeAgentSyncStatus {
  const claudeCandidates = [
    path.join(workspacePath, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.json'),
  ]
  const claudeSettingsPath = claudeCandidates.find(p => fs.existsSync(p)) || claudeCandidates[0]
  let claudeSynced = false
  let claudeAllowCount = 0
  let claudeDenyCount = 0
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'))
      claudeSynced = true
      claudeAllowCount = Array.isArray(data?.permissions?.allow) ? data.permissions.allow.length : 0
      claudeDenyCount = Array.isArray(data?.permissions?.deny) ? data.permissions.deny.length : 0
    } catch {}
  }

  const codexCandidates = [
    path.join(workspacePath, '.codex', 'rules', 'generated-agents-policy.rules'),
    path.join(workspacePath, '.codex', 'rules', 'default.rules'),
    path.join(homeDir, '.codex', 'rules', 'generated-agents-policy.rules'),
    path.join(homeDir, '.codex', 'rules', 'default.rules'),
  ]
  const codexRulesPath = codexCandidates.find(p => fs.existsSync(p)) || codexCandidates[0]
  let codexSynced = false
  let codexRuleCount = 0
  if (fs.existsSync(codexRulesPath)) {
    try {
      const content = fs.readFileSync(codexRulesPath, 'utf8')
      codexSynced = true
      codexRuleCount = (content.match(/prefix_rule\s*\(/g) || []).length
    } catch {}
  }

  const geminiCandidates = [
    path.join(workspacePath, '.gemini', 'settings.json'),
    path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'),
  ]
  const geminiSettingsPath = geminiCandidates.find(p => fs.existsSync(p)) || geminiCandidates[0]
  let geminiSynced = false
  let geminiAllowCount = 0
  let geminiDenyCount = 0
  if (fs.existsSync(geminiSettingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(geminiSettingsPath, 'utf8'))
      geminiSynced = true
      if (Array.isArray(data?.permissions?.allow)) {
        geminiAllowCount = data.permissions.allow.length
        geminiDenyCount = Array.isArray(data?.permissions?.deny) ? data.permissions.deny.length : 0
      } else if (Array.isArray(data?.permissions)) {
        geminiAllowCount = data.permissions.length
        geminiDenyCount = Array.isArray(data?.tools?.exclude) ? data.tools.exclude.length : 0
      } else {
        geminiAllowCount = Array.isArray(data?.tools?.allowed) ? data.tools.allowed.length : 0
        geminiDenyCount = Array.isArray(data?.tools?.exclude) ? data.tools.exclude.length : 0
      }
    } catch {}
  }

  // Detect remote company policy URL
  let remotePolicyUrl: string | null = null
  if (process.env.COMPANY_PERMISSIONS_URL) {
    remotePolicyUrl = process.env.COMPANY_PERMISSIONS_URL.trim()
  } else if (process.env.AGENT_PERMISSIONS_URL) {
    remotePolicyUrl = process.env.AGENT_PERMISSIONS_URL.trim()
  } else {
    const candidateConfigs = [
      path.join(workspacePath, '.agents', 'config.json'),
      path.join(homeDir, '.agents', 'config.json'),
    ]
    for (const cfgPath of candidateConfigs) {
      if (fs.existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
          if (cfg.remoteBaselineUrl || cfg.companyPermissionsUrl) {
            remotePolicyUrl = (cfg.remoteBaselineUrl || cfg.companyPermissionsUrl).trim()
            break
          }
        } catch {}
      }
    }
  }

  const remoteCachePath = path.join(homeDir, '.agents', 'cache', 'company-remote-baseline.yml')
  const remotePolicyCached = fs.existsSync(remoteCachePath)

  // Detect Claude Code SessionStart auto-sync hook
  let sessionStartHookActive = false
  for (const p of [claudeSettingsPath, path.join(homeDir, '.claude', 'settings.json')]) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8')
        if (raw.includes('agent-cli-permissions sync') || raw.includes('agent-permissions sync')) {
          sessionStartHookActive = true
          break
        }
      } catch {}
    }
  }

  // Detect Git pre-commit compliance hook
  const gitHookPath = path.join(workspacePath, '.git', 'hooks', 'pre-commit')
  let gitHookActive = false
  if (fs.existsSync(gitHookPath)) {
    try {
      const gitContent = fs.readFileSync(gitHookPath, 'utf8')
      if (gitContent.includes('agent-cli-permissions check') || gitContent.includes('agent-permissions check')) {
        gitHookActive = true
      }
    } catch {}
  }

  return {
    claudeSettingsPath,
    claudeSynced,
    claudeAllowCount,
    claudeDenyCount,
    codexRulesPath,
    codexSynced,
    codexRuleCount,
    geminiSettingsPath,
    geminiSynced,
    geminiAllowCount,
    geminiDenyCount,
    remotePolicyUrl,
    remotePolicyCached,
    sessionStartHookActive,
    gitHookActive,
  }
}
