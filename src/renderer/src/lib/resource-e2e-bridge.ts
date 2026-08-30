import type { ResourceDump } from '../../../shared/resource-recorder-types'
import { e2eConfig } from './e2e-config'

export type OrcaE2EResourceBridge = {
  dump: () => Promise<ResourceDump>
  mark: (name: string) => void
}

export type OrcaE2EGlobal = {
  resources: OrcaE2EResourceBridge
}

export function installResourceE2EBridge(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const e2eWindow = window as unknown as Record<string, unknown>
  // Zero new surface when the bridge is off: the global is never even defined.
  e2eWindow.__orcaE2E__ = {
    resources: {
      dump: () => {
        const api = window.api as {
          resources?: OrcaE2EResourceBridge
        }
        if (!api.resources) {
          return Promise.reject(new Error('recorder-disabled'))
        }
        return api.resources.dump()
      },
      mark: (name: string) => {
        const api = window.api as {
          resources?: OrcaE2EResourceBridge
        }
        api.resources?.mark(name)
      }
    }
  }
}
