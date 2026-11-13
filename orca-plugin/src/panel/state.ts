import type { PolicyInspectionReport } from '../types.ts'

export const panelState = {
  currentReport: null as PolicyInspectionReport | null,
  searchFilter: '',
  actionFilter: 'all',
  openApps: new Set<string>(),
}
