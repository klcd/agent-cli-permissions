import type {
  CommandEvaluationResult,
  PolicyInspectionReport,
} from '../types.ts'
import { panelState } from './state.ts'
import { copyText, escapeHtml } from './utils.ts'
import { renderCliTab } from './views/cli-tab.ts'

function getInputValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
  return el ? el.value : ''
}

function renderHeader(): void {
  const report = panelState.currentReport
  if (!report) return

  const ws = report.selectedWorkspace
  const projLabel = document.getElementById('projectLabel')
  if (projLabel) projLabel.textContent = ws.name
  const projBox = document.getElementById('projectStatBox')
  if (projBox) projBox.title = ws.path
  const branchBadge = document.getElementById('branchBadge')
  if (branchBadge) branchBadge.textContent = ws.branch || 'main'

  const agentRules = report.allCliRules.filter(r =>
    r.compatibleAgents.includes(report.currentAgent)
  )
  const cliCountLabel = document.getElementById('cliCountLabel')
  if (cliCountLabel) {
    const allowCount = agentRules.filter(r => r.action === 'allow').length
    const denyCount = agentRules.filter(r => r.action === 'deny').length
    cliCountLabel.textContent = `${agentRules.length} (${allowCount} allow / ${denyCount} deny)`
  }

  const syncBadge = document.getElementById('syncBadge')
  if (syncBadge) {
    const ns = report.nativeSync
    const syncedCount =
      (ns?.claudeSynced ? 1 : 0) +
      (ns?.codexSynced ? 1 : 0) +
      (ns?.geminiSynced ? 1 : 0)
    if (syncedCount >= 2) {
      syncBadge.className = 'badge allow'
      syncBadge.textContent = 'Synced'
      syncBadge.title = 'Canonical ~/.agents/permissions/*.yml rules synced to native agent configs'
    } else {
      syncBadge.className = 'badge neutral'
      syncBadge.textContent = `${report.permissionGroups.length} groups`
      syncBadge.title = 'Loaded permission groups from ~/.agents/permissions/*.yml'
    }
  }
}

async function runPermissionCheck(command: string): Promise<void> {
  const report = panelState.currentReport
  const trimmed = command.trim()
  if (!trimmed || !report) return
  const box = document.getElementById('evalOutput')
  if (!box) return

  try {
    const res = (await window.orca.plugin.request('evaluateCommand', {
      command: trimmed,
      workspacePath: report.selectedWorkspace.path,
      agent: report.currentAgent,
    })) as CommandEvaluationResult
    box.style.display = 'flex'
    const dotClassForAction = (act: string) =>
      act === 'allow' || act === 'pass' ? 'rw' : act === 'ask' || act === 'warn' ? 'l7' : 'deny'
    const verdictDot = dotClassForAction(res.verdict)
    const rulesHtml = (res.matchedRules || [])
      .map(r => {
        const rDot = dotClassForAction(r.action)
        return `<div class="cmd-meta" style="align-items:center;"><span class="access-dot ${rDot}"></span><span class="mono" style="color:var(--fg);font-weight:600;">${escapeHtml(r.cliCommand)}</span><span class="source-pill">&#8984; ${escapeHtml(r.groupName)} (${escapeHtml(r.sourceFile)})</span></div>`
      })
      .join('')

    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:7px;min-width:0;">
          <span class="access-dot ${verdictDot}"></span>
          <span class="mono" style="font-weight:600;color:var(--fg);">${escapeHtml(res.command)}</span>
        </div>
        <span class="source-pill">${escapeHtml(res.verdict.toUpperCase())}</span>
      </div>
      <div class="sub">${escapeHtml(res.summary)}</div>
      ${rulesHtml}
    `
  } catch (err: any) {
    box.style.display = 'flex'
    box.innerHTML = `<div style="display:flex;align-items:center;gap:6px;"><span class="access-dot deny"></span><div>${escapeHtml(err?.message || err)}</div></div>`
  }
}

function renderPermissionsView(): void {
  if (!panelState.currentReport) return
  const container = document.getElementById('tabContent')
  if (!container) return

  container.innerHTML = renderCliTab()

  container.querySelectorAll<HTMLDetailsElement>('details.app-fold').forEach(el => {
    el.addEventListener('toggle', () => {
      const app = el.dataset.app
      if (app) {
        if (el.open) panelState.openApps.add(app)
        else panelState.openApps.delete(app)
      }
    })
  })

  document.getElementById('expandAllBtn')?.addEventListener('click', () => {
    container.querySelectorAll<HTMLDetailsElement>('details.app-fold').forEach(el => {
      el.open = true
      if (el.dataset.app) panelState.openApps.add(el.dataset.app)
    })
  })

  document.getElementById('collapseAllBtn')?.addEventListener('click', () => {
    panelState.openApps.clear()
    container.querySelectorAll<HTMLDetailsElement>('details.app-fold').forEach(el => {
      el.open = false
    })
  })

  document.getElementById('ruleSearch')?.addEventListener('input', e => {
    panelState.searchFilter = (e.target as HTMLInputElement).value
    renderPermissionsView()
    const input = document.getElementById('ruleSearch') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  })

  document.getElementById('actionSelect')?.addEventListener('change', e => {
    panelState.actionFilter = (e.target as HTMLSelectElement).value
    renderPermissionsView()
  })
}

async function loadReport(): Promise<void> {
  try {
    const res = (await window.orca.plugin.request('getPolicyReport', {})) as PolicyInspectionReport
    panelState.currentReport = res
    renderHeader()
    if (document.activeElement?.id !== 'ruleSearch') {
      renderPermissionsView()
    }
  } catch (err: any) {
    const container = document.getElementById('tabContent')
    if (container) {
      container.innerHTML = `<div class="card"><span class="badge deny">Error</span><div class="mono">${escapeHtml(err?.message || err)}</div></div>`
    }
  }
}

function bootstrapPanel(): void {
  document.addEventListener('click', e => {
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    if (target.dataset.copy) {
      void copyText(target.dataset.copy, target)
    }
  })

  document.getElementById('refreshBtn')?.addEventListener('click', () => {
    void loadReport()
  })

  document.getElementById('syncBtn')?.addEventListener('click', async () => {
    const syncBtn = document.getElementById('syncBtn') as HTMLButtonElement | null
    const notice = document.getElementById('syncStatusNotice')
    if (syncBtn) {
      syncBtn.disabled = true
      syncBtn.textContent = 'Syncing...'
    }
    try {
      const report = panelState.currentReport
      const res = (await window.orca.plugin.request('syncPermissions', {
        workspacePath: report?.selectedWorkspace?.path,
      })) as { ok: boolean; message: string; report?: PolicyInspectionReport }
      if (notice) {
        notice.style.display = 'flex'
        notice.innerHTML = `<div style="display:flex;align-items:center;gap:6px;"><span class="badge ${res.ok ? 'allow' : 'deny'}">${res.ok ? 'SYNCED' : 'ERROR'}</span><span class="sub">${escapeHtml(res.message)}</span></div>`
      }
      if (res.report) {
        panelState.currentReport = res.report
        renderHeader()
        renderPermissionsView()
      }
    } catch (err: any) {
      if (notice) {
        notice.style.display = 'flex'
        notice.innerHTML = `<div style="display:flex;align-items:center;gap:6px;"><span class="badge deny">ERROR</span><span class="sub">${escapeHtml(err?.message || err)}</span></div>`
      }
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false
        syncBtn.textContent = 'Sync Rules'
      }
    }
  })

  document.getElementById('testBtn')?.addEventListener('click', () => {
    void runPermissionCheck(getInputValue('cmdInput'))
  })

  document.getElementById('cmdInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      void runPermissionCheck((e.target as HTMLInputElement).value)
    }
  })

  const tooltipEl = document.getElementById('orcaTooltip')
  const positionTooltip = (clientX: number, clientY: number) => {
    if (!tooltipEl || tooltipEl.style.display === 'none') return
    const pad = 10
    const rect = tooltipEl.getBoundingClientRect()
    let left = clientX + 12
    let top = clientY + 14
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad)
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, clientY - rect.height - 10)
    }
    tooltipEl.style.left = `${left}px`
    tooltipEl.style.top = `${top}px`
  }

  document.addEventListener('mouseover', e => {
    if (!tooltipEl) return
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    const host = target.closest<HTMLElement>('[data-tooltip]')
    if (!host) {
      tooltipEl.style.display = 'none'
      return
    }
    const text = host.dataset.tooltip?.trim()
    if (!text) {
      tooltipEl.style.display = 'none'
      return
    }
    tooltipEl.textContent = text
    tooltipEl.style.display = 'block'
    positionTooltip(e.clientX, e.clientY)
  })

  document.addEventListener('mousemove', e => {
    positionTooltip(e.clientX, e.clientY)
  })

  document.addEventListener('mouseout', e => {
    if (!tooltipEl) return
    const related = e.relatedTarget
    if (!(related instanceof HTMLElement) || !related.closest('[data-tooltip]')) {
      tooltipEl.style.display = 'none'
    }
  })

  window.addEventListener('scroll', () => {
    if (tooltipEl) tooltipEl.style.display = 'none'
  }, true)

  window.addEventListener('focus', () => {
    void loadReport()
  })

  void loadReport()
}

bootstrapPanel()
