import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

function getLinuxDisplayServer(): 'wayland' | 'x11' | null {
  if (process.platform !== 'linux') {
    return null
  }
  if (
    process.env.WAYLAND_DISPLAY ||
    process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
    process.env.ELECTRON_OZONE_PLATFORM_HINT?.toLowerCase() === 'wayland'
  ) {
    return 'wayland'
  }
  return process.env.DISPLAY ? 'x11' : null
}

export const platformBridge: PreloadApi['platform'] = {
  get: () => ({
    platform: process.platform,
    // Why: sandboxed preload cannot require node:os; Electron exposes the OS
    // version on process.getSystemVersion when available.
    osRelease:
      (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ?? '',
    arch: process.arch,
    // Why: these identify the default shell without probing user config files.
    // process.env is available in the sandboxed preload; node:os is not.
    shell: process.env.SHELL?.trim() || process.env.ComSpec?.trim() || '',
    displayServer: getLinuxDisplayServer()
  })
}

export const wslBridge: PreloadApi['wsl'] = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable'),
  listDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listDistros')
}

export const pwshBridge: PreloadApi['pwsh'] = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('pwsh:isAvailable')
}

export const gitBashBridge: PreloadApi['gitBash'] = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('gitBash:isAvailable')
}
