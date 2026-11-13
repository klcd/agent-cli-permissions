import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PolicyInspectionReport, WorkspaceEntry } from '../types.ts'
import { inspectNativeSync, loadPermissionGroups } from '../parsers/permission-yaml.ts'

/** Read the current branch name from a workspace's `.git/HEAD`, if present. */
function readGitBranch(workspacePath: string): string | null {
  try {
    const head = fs.readFileSync(path.join(workspacePath, '.git', 'HEAD'), 'utf8').trim()
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return match ? match[1] : head.slice(0, 12) || null
  } catch {
    return null
  }
}

/** Describe a workspace from its path alone (no host calls, no Orca state). */
export function describeWorkspace(workspacePath: string): WorkspaceEntry {
  const resolved = path.resolve(workspacePath)
  const base = path.basename(resolved)
  return {
    id: resolved,
    // A root/empty path means no workspace is focused; show company (global) rules only.
    name: base || '(no workspace)',
    path: resolved,
    branch: readGitBranch(resolved),
  }
}

/**
 * Build the panel's report by reading permission files only.
 *
 * Reads `~/.agents/permissions/*.yml` (company baseline) and
 * `<workspace>/.agents/permissions/*.yml` (project rules), plus the native agent
 * config files to report sync status. It never spawns a process and never writes
 * to disk.
 */
export function buildPolicyReport(options?: {
  workspacePath?: string
  agent?: 'claude' | 'codex' | 'antigravity'
  homeDir?: string
}): PolicyInspectionReport {
  const homeDir = options?.homeDir || os.homedir()
  const workspacePath = options?.workspacePath || process.cwd()
  const selectedWorkspace = describeWorkspace(workspacePath)
  const currentAgent = options?.agent || 'claude'

  const permissionGroups = loadPermissionGroups(selectedWorkspace.path, homeDir)
  const allCliRules = permissionGroups.flatMap(g => g.rules)

  return {
    generatedAt: new Date().toISOString(),
    selectedWorkspace,
    currentAgent,
    permissionGroups,
    allCliRules,
    nativeSync: inspectNativeSync(selectedWorkspace.path, homeDir),
  }
}
