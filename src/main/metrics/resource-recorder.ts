// MERGE: replaced by exp/mem-obs-m1 (M1 owns this module; thin contract stub).
import type { ResourceRecorder } from '../../shared/resource-recorder-types'

let recorder: ResourceRecorder | null = null

export function getResourceRecorder(): ResourceRecorder | null {
  return recorder
}

export function startResourceRecorderIfEnabled(): void {
  // Stub: real recorder start lives on the M1 lane.
}
