import { ipcRenderer } from 'electron'
import type { BrowserApi } from '../api/browser-api'

export const browserSessionBridge: Pick<
  BrowserApi,
  | 'sessionListProfiles'
  | 'prepareSshWorkspacePartition'
  | 'sessionCreateProfile'
  | 'sessionDeleteProfile'
  | 'sessionImportCookies'
  | 'sessionResolvePartition'
  | 'sessionDetectBrowsers'
  | 'sessionDetectBrowsersForClientHost'
  | 'sessionImportFromBrowser'
  | 'sessionImportFromBrowserForClientHost'
  | 'sessionClientRouteImportSources'
  | 'sessionClearDefaultCookies'
  | 'notifyActiveTabChanged'
> = {
  sessionListProfiles: () => ipcRenderer.invoke('browser:session:listProfiles'),

  prepareSshWorkspacePartition: (args: {
    targetId: string
    browserProfileId?: string
    skipProbe?: boolean
  }): Promise<{ partition: string }> =>
    ipcRenderer.invoke('browser:prepareSshWorkspacePartition', args),

  sessionCreateProfile: (args: {
    scope: 'default' | 'isolated' | 'imported'
    label: string
    userAgentMode?: 'clean' | 'native'
  }) => ipcRenderer.invoke('browser:session:createProfile', args),

  sessionDeleteProfile: (args: { profileId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:session:deleteProfile', args),

  sessionImportCookies: (args: { profileId: string }) =>
    ipcRenderer.invoke('browser:session:importCookies', args),

  sessionResolvePartition: (args: { profileId: string | null }): Promise<string | null> =>
    ipcRenderer.invoke('browser:session:resolvePartition', args),

  sessionDetectBrowsers: () => ipcRenderer.invoke('browser:session:detectBrowsers'),

  sessionDetectBrowsersForClientHost: (args: { environmentId: string }) =>
    ipcRenderer.invoke('browser:session:detectBrowsersForClientHost', args),

  sessionImportFromBrowser: (args: { profileId: string; browserFamily: string }) =>
    ipcRenderer.invoke('browser:session:importFromBrowser', args),

  sessionImportFromBrowserForClientHost: (args: {
    environmentId: string
    profileId: string
    browserFamily: string
    browserProfile?: string
  }) => ipcRenderer.invoke('browser:session:importFromBrowserForClientHost', args),

  sessionClientRouteImportSources: (args: { environmentId: string }) =>
    ipcRenderer.invoke('browser:session:clientRouteImportSources', args),

  sessionClearDefaultCookies: (): Promise<boolean> =>
    ipcRenderer.invoke('browser:session:clearDefaultCookies'),

  notifyActiveTabChanged: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:activeTabChanged', args)
}
