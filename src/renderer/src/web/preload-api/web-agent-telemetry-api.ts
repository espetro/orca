import type { AgentAwakeApi, AgentTrustApi } from '../../../../preload/api/agent-status-api'
import type {
  ClaudeUsageApi,
  CodexUsageApi,
  OpenCodeUsageApi
} from '../../../../preload/api/agent-usage-api'
import type { ResourceRecorderBridgeApi } from '../../../../preload/api/app-api'
import { noopUnsubscribe } from './web-storage'

const emptyUsageScanState = {
  enabled: false,
  isScanning: false,
  lastScanStartedAt: null,
  lastScanCompletedAt: null,
  lastScanError: null,
  hasAnyClaudeData: false
}

export function createUsageApi(): ClaudeUsageApi & CodexUsageApi & OpenCodeUsageApi {
  return {
    getScanState: async () => emptyUsageScanState as never,
    setEnabled: async () => emptyUsageScanState as never,
    refresh: async () => emptyUsageScanState as never,
    getSnapshot: async (args) =>
      ({
        scanState: emptyUsageScanState,
        summary: { scope: args.scope, range: args.range },
        daily: [],
        modelBreakdown: [],
        recentSessions: []
      }) as never,
    getSummary: async (args) => ({ scope: args.scope, range: args.range }) as never,
    getDaily: async () => [],
    getBreakdown: async () => [],
    getRecentSessions: async () => []
  }
}

export function createAgentTrustDegradedApi(): AgentTrustApi {
  return {
    markTrusted: async () => {}
  }
}

export function createResourcesDegradedApi(): ResourceRecorderBridgeApi {
  return {
    dump: async () => ({ processes: [], snapshots: [] }) as never,
    mark: () => {}
  }
}

export function createAgentAwakeDegradedApi(): AgentAwakeApi {
  return {
    getStatus: async () => ({ mode: 'off', active: false }),
    onChanged: () => noopUnsubscribe
  }
}
