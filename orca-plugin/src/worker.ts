import type { OrcaWorkerApi } from 'orca/worker'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPolicyReport,
  buildPolicyReportAsync,
  evaluateCommandPolicy,
  getAugmentedEnv,
} from './policy-inspector.ts'

export function syncCanonicalPermissions(
  workspacePath?: string,
  homeDir = os.homedir()
): { ok: boolean; message: string } {
  const workerDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(workerDir, '..', '..')
  const repoSyncScript = path.join(repoRoot, 'scripts', 'sync-permissions.mjs')
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'sync-agent-permissions'),
    path.join(homeDir, '.agents', 'bin', 'sync-agent-permissions'),
    path.join(homeDir, '.agents', 'scripts', 'sync-agent-permissions.sh'),
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
      const out = execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
        env: getAugmentedEnv(homeDir),
      }).trim()
      const lines = out.split(/\r?\n/).filter(Boolean)
      const summaryLine = lines[lines.length - 1] || lines[0] || ''
      return {
        ok: true,
        message:
          summaryLine ||
          'Synced ~/.agents/permissions/*.yml across Claude, Codex, Antigravity, Cursor, and OpenCode.',
      }
    } catch (err: any) {
      return {
        ok: false,
        message: String(err?.stderr || err?.message || err).trim(),
      }
    }
  }
  const report = buildPolicyReport({ workspacePath, homeDir })
  return {
    ok: true,
    message: `Reloaded ${report.permissionGroups.length} permission group(s) (${report.allCliRules.length} CLI rules).`,
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  const toStrictJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  orca.panels?.handle('getPolicyReport', async (input) => {
    const req = (input && typeof input === 'object' ? input : {}) as {
      workspacePath?: string
      agent?: string
    }
    const report = await buildPolicyReportAsync({
      workspacePath: req.workspacePath,
      agent: req.agent,
    })
    return toStrictJson(report)
  })

  orca.panels?.handle('evaluateCommand', async (input) => {
    const req = (input && typeof input === 'object' ? input : {}) as {
      command?: string
      workspacePath?: string
      agent?: string
    }
    const report = await buildPolicyReportAsync({
      workspacePath: req.workspacePath,
      agent: req.agent,
    })
    return toStrictJson(evaluateCommandPolicy(String(req.command || ''), report))
  })

  orca.panels?.handle('syncPermissions', async (input) => {
    const req = (input && typeof input === 'object' ? input : {}) as {
      workspacePath?: string
      agent?: string
    }
    const syncRes = syncCanonicalPermissions(req.workspacePath)
    const report = await buildPolicyReportAsync({
      workspacePath: req.workspacePath,
      agent: req.agent,
    })
    return toStrictJson({
      ...syncRes,
      report,
    })
  })

  orca.commands?.register('agentPermissions.sync', async () => {
    const res = syncCanonicalPermissions()
    if (orca.host?.call) {
      void orca.host
        .call('notifications.info', {
          message: res.message,
        })
        .catch(() => {})
    }
    return toStrictJson(res)
  })
}
