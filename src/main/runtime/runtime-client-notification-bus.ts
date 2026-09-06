import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import {
  MobileNotificationReplayBuffer,
  type ReplayableMobileNotification
} from './mobile-notification-replay'
import type { MobileNotificationEvent } from './runtime-contracts'

export type RuntimeClientNotificationBusDeps = {
  dispatchMobileNotification: (event: MobileNotificationEvent) => void
}

/** Listener registry + replay buffer + plugin dispatch for mobile notifications.
 *  The replay buffer is a global, idempotent-by-seq source of truth; clients
 *  watermark their own position (see #8129). */
export class RuntimeClientNotificationBus {
  private readonly listeners = new Set<(event: MobileNotificationEvent) => void>()
  private readonly replay = new MobileNotificationReplayBuffer()

  constructor(private readonly deps: RuntimeClientNotificationBusDeps) {}

  onNotificationDispatched(listener: (event: MobileNotificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  get notificationListeners(): Set<(event: MobileNotificationEvent) => void> {
    return this.listeners
  }

  getMissedNotificationsSince(lastSeenSeq: number, epoch?: string): ReplayableMobileNotification[] {
    return this.replay.getMissedSince(lastSeenSeq, epoch)
  }

  /** Plugin panel action notifications.show. Native on desktop, relayed to
   *  paired mobile clients either way (mirrors notifications:dispatch). */
  async dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }> {
    // Why: prefix with the plugin id so a plugin cannot spoof an Orca system
    // notification or impersonate another plugin.
    const title = `${input.pluginId}: ${input.title}`
    const body = input.body ?? ''
    let delivered = false
    try {
      delivered = getRuntimeDesktopSurface().showNotification({ title, body })
    } catch {
      // A host with no notification display still relays to paired clients below.
    }
    this.deps.dispatchMobileNotification({
      type: 'notification',
      source: 'plugin',
      title,
      body
    })
    return { delivered }
  }
}
