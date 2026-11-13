import type { OrcaWorkerApi } from 'orca/worker'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPolicyReport, evaluateCommandPolicy } from './policy-inspector.ts'

type AgentId = 'claude' | 'codex' | 'antigravity'

/** Keep only a recognised agent id; anything else falls back to the report default. */
function asAgent(value: unknown): AgentId | undefined {
  return value === 'claude' || value === 'codex' || value === 'antigravity' ? value : undefined
}

/**
 * Find the folder of the workspace the user is looking at, so we read the right
 * project's `.agents/permissions`. Uses only the documented, capability-gated
 * host API (`workspace:read`): `workspace.readContext` says which workspace is
 * focused, `workspace.list` gives its path. Falls back to the current directory.
 */
async function resolveWorkspacePath(orca: OrcaWorkerApi, explicit?: string): Promise<string> {
  if (explicit && fs.existsSync(explicit)) return explicit
  try {
    const call = orca.host?.call
    if (call) {
      const ctx = (await call('workspace.readContext')) as
        | { name?: string; branch?: string | null }
        | null
      if (ctx?.name) {
        const listed = (await call('workspace.list', {})) as {
          workspaces?: Array<{ name: string; path: string; branch: string | null }>
        }
        const ws =
          listed.workspaces?.find(
            w => w.name === ctx.name && (ctx.branch == null || w.branch === ctx.branch) && w.path
          ) || listed.workspaces?.find(w => w.name === ctx.name && w.path)
        if (ws?.path) return ws.path
      }
    }
  } catch {
    // Host unavailable or workspace unknown: fall back below.
  }
  return explicit || process.cwd()
}

/**
 * Run the bundled sync CLI to write `~/.agents/permissions/*.yml` out to each
 * native agent config. Shells out to this project's own `agent-permissions`
 * script when present (a dev checkout); otherwise reports the loaded rule count.
 */
export function syncCanonicalPermissions(
  workspacePath?: string,
  homeDir = os.homedir()
): { ok: boolean; message: string } {
  const workerDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(workerDir, '..', '..')
  const repoSyncScript = path.join(repoRoot, 'src', 'sync-permissions.mjs')
  const repoBinScript = path.join(repoRoot, 'bin', 'agent-permissions.mjs')
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'sync-agent-permissions'),
    path.join(homeDir, '.agents', 'bin', 'sync-agent-permissions'),
    path.join(homeDir, '.agents', 'scripts', 'sync-agent-permissions.sh'),
    repoBinScript,
    repoSyncScript,
  ]
  const syncBin = candidates.find(p => fs.existsSync(p))
  if (syncBin && homeDir === os.homedir()) {
    try {
      const isMjs = syncBin.endsWith('.mjs') || syncBin.endsWith('.js')
      const cmd = isMjs ? process.execPath : syncBin
      const args = isMjs ? [syncBin] : workspacePath ? [workspacePath] : []
      const hasWorkspacePerms =
        workspacePath && fs.existsSync(path.join(workspacePath, '.agents', 'permissions'))
      const cwd = hasWorkspacePerms ? workspacePath! : repoRoot
      const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000 }).trim()
      const lines = out.split(/\r?\n/).filter(Boolean)
      const summaryLine = lines[lines.length - 1] || lines[0] || ''
      return {
        ok: true,
        message:
          summaryLine ||
          'Synced ~/.agents/permissions/*.yml across Claude, Codex, Antigravity, Cursor, and OpenCode.',
      }
    } catch (err: any) {
      return { ok: false, message: String(err?.stderr || err?.message || err).trim() }
    }
  }
  const report = buildPolicyReport({ workspacePath, homeDir })
  return {
    ok: true,
    message: `Reloaded ${report.permissionGroups.length} permission group(s) (${report.allCliRules.length} CLI rules).`,
  }
}

/** Install the SessionStart auto-sync hook and the Git pre-commit gate via the bundled CLI. */
export function installHooksHandler(
  workspacePath?: string,
  homeDir = os.homedir()
): { ok: boolean; message: string } {
  const workerDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(workerDir, '..', '..')
  const repoBinScript = path.join(repoRoot, 'bin', 'agent-permissions.mjs')
  if (fs.existsSync(repoBinScript)) {
    try {
      execFileSync(process.execPath, [repoBinScript, 'install-hooks', '--project'], {
        cwd: workspacePath || repoRoot,
        encoding: 'utf8',
        timeout: 10000,
      })
      execFileSync(process.execPath, [repoBinScript, 'install-git-hook', 'pre-commit'], {
        cwd: workspacePath || repoRoot,
        encoding: 'utf8',
        timeout: 10000,
      })
      return {
        ok: true,
        message: 'Configured SessionStart auto-sync hook and Git pre-commit compliance gate.',
      }
    } catch (err: any) {
      return { ok: false, message: String(err?.stderr || err?.message || err).trim() }
    }
  }
  return { ok: true, message: 'Hooks configured.' }
}

export default function activate(orca: OrcaWorkerApi): void {
  const toStrictJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const asObj = (input: unknown) =>
    (input && typeof input === 'object' ? input : {}) as { workspacePath?: string; agent?: string; command?: string }

  orca.panels?.handle('getPolicyReport', async (input) => {
    const req = asObj(input)
    const workspacePath = await resolveWorkspacePath(orca, req.workspacePath)
    return toStrictJson(buildPolicyReport({ workspacePath, agent: asAgent(req.agent) }))
  })

  orca.panels?.handle('evaluateCommand', async (input) => {
    const req = asObj(input)
    const workspacePath = await resolveWorkspacePath(orca, req.workspacePath)
    const report = buildPolicyReport({ workspacePath, agent: asAgent(req.agent) })
    return toStrictJson(evaluateCommandPolicy(String(req.command || ''), report))
  })

  orca.panels?.handle('syncPermissions', async (input) => {
    const req = asObj(input)
    const workspacePath = await resolveWorkspacePath(orca, req.workspacePath)
    const syncRes = syncCanonicalPermissions(workspacePath)
    const report = buildPolicyReport({ workspacePath, agent: asAgent(req.agent) })
    return toStrictJson({ ...syncRes, report })
  })

  orca.panels?.handle('installHooks', async (input) => {
    const req = asObj(input)
    const workspacePath = await resolveWorkspacePath(orca, req.workspacePath)
    const hookRes = installHooksHandler(workspacePath)
    const report = buildPolicyReport({ workspacePath, agent: asAgent(req.agent) })
    return toStrictJson({ ...hookRes, report })
  })

  orca.commands?.register('agentPermissions.sync', async () => {
    const res = syncCanonicalPermissions()
    if (orca.host?.call) {
      void orca.host
        .call('notifications.show', { title: 'Agent CLI Permissions', body: res.message })
        .catch(() => {})
    }
    return toStrictJson(res)
  })
}
