import { ipcRenderer } from 'electron'
import type { TelemetryConsentState } from '../../shared/telemetry-consent-types'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { PreloadApi } from '../api-types'

export const telemetryBridge: Pick<
  PreloadApi,
  'telemetryTrack' | 'telemetrySetOptIn' | 'telemetryAcknowledgeBanner' | 'telemetryGetConsentState'
> = {
  // Why: main validates telemetry; renderer call sites use typed wrappers.
  telemetryTrack: (name: string, props: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('telemetry:track', name, props),
  telemetrySetOptIn: (optedIn: boolean): Promise<void> =>
    ipcRenderer.invoke('telemetry:setOptIn', optedIn),
  telemetryAcknowledgeBanner: (): Promise<void> =>
    ipcRenderer.invoke('telemetry:acknowledgeBanner'),
  telemetryGetConsentState: (): Promise<TelemetryConsentState> =>
    ipcRenderer.invoke('telemetry:getConsentState')
}

// Why: bridges are deliberately loose — main type-narrows this untrusted renderer input (see telemetry-error-tracking.md).
export const diagnosticsBridge: PreloadApi['diagnostics'] = {
  getStatus: () => ipcRenderer.invoke('diagnostics:getStatus'),
  collectBundle: (lookbackMinutes?: number) =>
    ipcRenderer.invoke('diagnostics:collectBundle', lookbackMinutes),
  openBundlePreview: (bundleSubmissionId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:openBundlePreview', bundleSubmissionId),
  discardBundlePreview: (bundleSubmissionId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:discardBundlePreview', bundleSubmissionId),
  uploadBundle: (bundleSubmissionId: string) =>
    ipcRenderer.invoke('diagnostics:uploadBundle', bundleSubmissionId),
  deleteBundle: (ticketId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:deleteBundle', ticketId)
}

export const statsBridge: PreloadApi['stats'] = {
  getSummary: (): Promise<{
    totalAgentsSpawned: number
    totalPRsCreated: number
    totalAgentTimeMs: number
    firstEventAt: number | null
  }> => ipcRenderer.invoke('stats:summary')
}

export const memoryBridge: PreloadApi['memory'] = {
  getSnapshot: (): Promise<MemorySnapshot> => ipcRenderer.invoke('memory:getSnapshot')
}
