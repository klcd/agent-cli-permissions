// Types for the Agent CLI Permissions plugin.
//
// The plugin does exactly one thing: read canonical `.agents/permissions/*.yml`
// rule files (global + project), show them, and test a command against them under
// DENY > ASK > ALLOW precedence. These types describe only that. There is no
// sandbox, network, or process-spawning model here.

/** One `allow` / `ask` / `deny` entry parsed from a permission YAML file. */
export interface CliPermissionRule {
  raw: string
  tool: string
  pattern: string
  cliCommand: string
  baseBinary: string
  action: 'allow' | 'ask' | 'deny'
  scope: 'global' | 'workspace'
  groupName: string
  groupDescription: string
  sourceFile: string
  explanation: string
  /** Which agents this rule applies to; every rule targets all supported agents. */
  compatibleAgents: string[]
}

/** One parsed permission file (a "permission group"). */
export interface PermissionGroupSummary {
  name: string
  description: string
  scope: 'global' | 'workspace'
  sourceFile: string
  allowCount: number
  askCount: number
  denyCount: number
  rules: CliPermissionRule[]
}

/** Read-only view of whether the canonical rules have been synced to each native agent config. */
export interface NativeAgentSyncStatus {
  claudeSettingsPath: string
  claudeSynced: boolean
  claudeAllowCount: number
  claudeDenyCount: number
  codexRulesPath: string
  codexSynced: boolean
  codexRuleCount: number
  geminiSettingsPath: string
  geminiSynced: boolean
  geminiAllowCount: number
  geminiDenyCount: number
  remotePolicyUrl: string | null
  remotePolicyCached: boolean
  sessionStartHookActive: boolean
  gitHookActive: boolean
}

/** The workspace whose rules are being shown. */
export interface WorkspaceEntry {
  id: string
  name: string
  path: string
  branch: string | null
}

/** Everything the panel renders. Pure data, computed by reading files only. */
export interface PolicyInspectionReport {
  generatedAt: string
  selectedWorkspace: WorkspaceEntry
  currentAgent: 'claude' | 'codex' | 'antigravity'
  permissionGroups: PermissionGroupSummary[]
  allCliRules: CliPermissionRule[]
  nativeSync: NativeAgentSyncStatus
}

/** Result of testing one command against the loaded rules. */
export interface CommandEvaluationResult {
  command: string
  verdict: 'allow' | 'deny' | 'ask'
  summary: string
  matchedRules: CliPermissionRule[]
}
