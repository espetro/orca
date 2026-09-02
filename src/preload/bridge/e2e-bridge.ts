import { ipcRenderer } from 'electron'
import { preloadE2EConfig } from '../e2e-config'
import type { ResourceDump } from '../../shared/resource-recorder-types'
import type { PreloadApi } from '../api-types'

export const e2eBridge: PreloadApi['e2e'] = {
  getConfig: () => preloadE2EConfig
}

// Only present in e2e-mode builds: feeds the renderer __orcaE2E__ resource bridge.
export const e2eResourcesBridge: PreloadApi['resources'] | undefined = preloadE2EConfig.exposeStore
  ? {
      dump: (): Promise<ResourceDump> => ipcRenderer.invoke('resources:dump'),
      mark: (name: string): void => {
        void ipcRenderer.invoke('resources:mark', name)
      }
    }
  : undefined
