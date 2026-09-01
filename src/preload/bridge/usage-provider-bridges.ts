import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const claudeUsageBridge: PreloadApi['claudeUsage'] = createUsageProviderApi(
  ipcRenderer,
  'claudeUsage'
)
export const codexUsageBridge: PreloadApi['codexUsage'] = createUsageProviderApi(
  ipcRenderer,
  'codexUsage'
)
export const openCodeUsageBridge: PreloadApi['openCodeUsage'] = createUsageProviderApi(
  ipcRenderer,
  'openCodeUsage'
)
