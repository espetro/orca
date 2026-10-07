import type { PostHog } from 'posthog-node'
import type { EventName } from '../../shared/telemetry-events'

export const OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS = 1_000

export function waitForCaptureEnqueue(
  client: PostHog,
  event: EventName,
  uuid: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let stopListening: (() => void) | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (enqueued: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      stopListening?.()
      resolve(enqueued)
    }

    // Why: posthog-node capture() enqueues async; this SDK event is the durable boundary before optOut().
    stopListening = client.on('capture', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the event/uuid reads below are guarded by strict equality against known values.
      const message = payload as { event?: unknown; uuid?: unknown }
      if (message.event === event && message.uuid === uuid) {
        settle(true)
      }
    })

    timeout = setTimeout(() => settle(false), OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS)
  })
}
