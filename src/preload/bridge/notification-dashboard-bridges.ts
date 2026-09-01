import { ipcRenderer } from 'electron'
import {
  clearNotificationSoundPlaybackState,
  disposeCachedNotificationSound,
  getCachedNotificationSound,
  setCachedNotificationSound,
  isNotificationSoundActive,
  setNotificationSoundPlaying,
  getCleanupHook,
  setCleanupHook,
  isCurrentCleanup
} from './notification-sound-state'
import type {
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundDataResult,
  NotificationSoundPathResult,
  NotificationSoundResult
} from '../../shared/notification-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type {
  DashboardRevealAgentArgs,
  DashboardSleepWorkspaceArgs,
  DashboardSnapshot,
  DashboardSpawnAgentArgs
} from '../../shared/dashboard-snapshot'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../shared/terminal-preview'
import type { PreloadApi } from '../api-types'

export const notificationsBridge: PreloadApi['notifications'] = {
  dispatch: (args: Record<string, unknown>): Promise<NotificationDispatchResult> =>
    ipcRenderer.invoke('notifications:dispatch', args),
  dismiss: (ids: string[]): Promise<NotificationDismissResult> =>
    ipcRenderer.invoke('notifications:dismiss', ids),
  openSystemSettings: (): Promise<void> => ipcRenderer.invoke('notifications:openSystemSettings'),
  getPermissionStatus: (): Promise<NotificationPermissionStatusResult> =>
    ipcRenderer.invoke('notifications:getPermissionStatus'),
  probeDelivery: (args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> =>
    ipcRenderer.invoke('notifications:probeDelivery', args),
  playSound: async (options?: {
    force?: boolean
    volume?: number
  }): Promise<NotificationSoundResult> => {
    try {
      // Why: drop replays while still ringing; the test button passes force to always confirm.
      if (!options?.force && isNotificationSoundActive()) {
        return { played: false, reason: 'deduped' }
      }

      const resolved = (await ipcRenderer.invoke(
        'notifications:resolveSoundPath'
      )) as NotificationSoundPathResult
      if (!resolved.ok) {
        if (getCachedNotificationSound()) {
          disposeCachedNotificationSound()
        }
        return { played: false, reason: resolved.reason }
      }

      let entry = getCachedNotificationSound()
      if (!entry || entry.path !== resolved.path) {
        const sound = (await ipcRenderer.invoke(
          'notifications:loadSound'
        )) as NotificationSoundDataResult
        if (!sound.ok) {
          disposeCachedNotificationSound()
          return { played: false, reason: sound.reason }
        }
        const arrayBuffer = new ArrayBuffer(sound.data.byteLength)
        new Uint8Array(arrayBuffer).set(sound.data)
        const blob = new Blob([arrayBuffer], { type: sound.mimeType })
        disposeCachedNotificationSound()
        const blobUrl = URL.createObjectURL(blob)
        entry = { path: sound.path, blobUrl, audio: new Audio(blobUrl) }
        setCachedNotificationSound(entry)
      }

      const audio = entry.audio
      // Why: restart from zero on each play so bursts replay instead of stacking copies (GNOME canberra / VS Code signal service).
      audio.currentTime = 0
      if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
        audio.volume = Math.min(1, Math.max(0, options.volume / 100))
      }
      setNotificationSoundPlaying(true)
      getCleanupHook()?.()
      const release = (): void => {
        cleanup()
        if (isCurrentCleanup(cleanup)) {
          setCleanupHook(null)
        }
        setNotificationSoundPlaying(false)
      }
      const cleanup = (): void => {
        audio.removeEventListener('ended', release)
        audio.removeEventListener('error', release)
      }
      setCleanupHook(cleanup)
      audio.addEventListener('ended', release)
      audio.addEventListener('error', release)
      try {
        await audio.play()
      } catch {
        release()
        return { played: false, reason: 'playback-failed' }
      }
      return { played: true }
    } catch {
      clearNotificationSoundPlaybackState()
      return { played: false, reason: 'playback-failed' }
    }
  }
}

export const onboardingBridge: PreloadApi['onboarding'] = {
  get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    }
  ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates)
}

export const dashboardBridge: PreloadApi['dashboard'] = {
  // Open the pop-out dashboard window, or focus it if already open.
  openPopout: (view?: 'board' | 'map'): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:open', view),

  // ── Producer side (main window) ──────────────────────────────────────
  publishSnapshot: (snapshot: DashboardSnapshot): Promise<void> =>
    ipcRenderer.invoke('dashboard:publishSnapshot', snapshot),
  getPopoutOpen: (): Promise<boolean> => ipcRenderer.invoke('dashboard:getPopoutOpen'),
  onPopoutOpenChanged: (callback: (open: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('dashboard:popoutOpenChanged', listener)
    return () => ipcRenderer.removeListener('dashboard:popoutOpenChanged', listener)
  },
  onSnapshotRequested: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('dashboard:snapshotRequested', listener)
    return () => ipcRenderer.removeListener('dashboard:snapshotRequested', listener)
  },
  onRevealAgent: (callback: (args: DashboardRevealAgentArgs) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, args: DashboardRevealAgentArgs): void =>
      callback(args)
    ipcRenderer.on('ui:revealDashboardAgent', listener)
    return () => ipcRenderer.removeListener('ui:revealDashboardAgent', listener)
  },
  onAckAgent: (callback: (paneKey: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, paneKey: string): void =>
      callback(paneKey)
    ipcRenderer.on('ui:ackDashboardAgent', listener)
    return () => ipcRenderer.removeListener('ui:ackDashboardAgent', listener)
  },
  onSpawnAgent: (callback: (args: DashboardSpawnAgentArgs) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, args: DashboardSpawnAgentArgs): void =>
      callback(args)
    ipcRenderer.on('ui:spawnDashboardAgent', listener)
    return () => ipcRenderer.removeListener('ui:spawnDashboardAgent', listener)
  },
  onSleepWorkspace: (callback: (args: DashboardSleepWorkspaceArgs) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      args: DashboardSleepWorkspaceArgs
    ): void => callback(args)
    ipcRenderer.on('ui:sleepDashboardWorkspace', listener)
    return () => ipcRenderer.removeListener('ui:sleepDashboardWorkspace', listener)
  },

  // ── Consumer side (pop-out window) ───────────────────────────────────
  requestSnapshot: (): Promise<void> => ipcRenderer.invoke('dashboard:requestSnapshot'),
  onSnapshot: (callback: (snapshot: DashboardSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('dashboard:snapshot', listener)
    return () => ipcRenderer.removeListener('dashboard:snapshot', listener)
  },
  onViewRequested: (callback: (view: 'board' | 'map') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, view: 'board' | 'map'): void =>
      callback(view)
    ipcRenderer.on('dashboard:viewRequested', listener)
    return () => ipcRenderer.removeListener('dashboard:viewRequested', listener)
  },
  revealAgent: (args: DashboardRevealAgentArgs): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:revealAgent', args),
  ackAgent: (paneKey: string): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:ackAgent', { paneKey }),
  spawnAgent: (args: DashboardSpawnAgentArgs): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:spawnAgent', args),
  sleepWorkspace: (args: DashboardSleepWorkspaceArgs): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:sleepWorkspace', args)
}

export const terminalPreviewBridge: PreloadApi['terminalPreview'] = {
  connect: (
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<TerminalPreviewConnectResult> =>
    ipcRenderer.invoke('terminalPreview:connect', { ptyId, opts }),
  input: (ptyId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('terminalPreview:input', { ptyId, data }),
  fit: (
    ptyId: string,
    cols: number,
    rows: number
  ): Promise<{ cols: number; rows: number } | null> =>
    ipcRenderer.invoke('terminalPreview:fit', { ptyId, cols, rows }),
  ack: (ptyId: string, bytes: number): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:ack', { ptyId, bytes }),
  unsubscribe: (ptyId: string): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:unsubscribe', { ptyId }),
  onData: (callback: (payload: TerminalPreviewDataPayload) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalPreviewDataPayload
    ): void => callback(payload)
    ipcRenderer.on('terminalPreview:data', listener)
    return () => ipcRenderer.removeListener('terminalPreview:data', listener)
  }
}
