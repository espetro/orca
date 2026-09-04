import type { RuntimeBrowserCommands } from './orca-runtime-browser'
import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'
import type { BrowserScreencastSubscriber } from './browser-screencast-driver-scope'

export type RuntimeBrowserScreencastCommandsDeps = {
  browserCommands: RuntimeBrowserCommands
  activeBrowserScreencastsByConnection: Map<
    string,
    Omit<BrowserScreencastSubscriber, 'drivesAsMobile'>
  >
  activeBrowserScreencastsByPage: Map<string, Set<BrowserScreencastSubscriber>>
  browserRemoteViewerPages: Set<string>
  currentBrowserDriver: Map<string, RuntimeBrowserDriverState>
  getBrowserDriver: (browserPageId: string) => RuntimeBrowserDriverState
  setBrowserDriver: (browserPageId: string, next: RuntimeBrowserDriverState) => void
  publishBrowserRemoteViewers: (browserPageId: string) => void
  registerSubscriptionCleanup: (
    subscriptionId: string,
    cleanup: () => void,
    connectionId?: string
  ) => void
  cleanupSubscription: (subscriptionId: string) => void
  notifier?: {
    browserDriverChanged?(browserPageId: string, driver: RuntimeBrowserDriverState): void
    browserRemoteViewersChanged?(browserPageId: string, hasRemoteViewers: boolean): void
  }
}
