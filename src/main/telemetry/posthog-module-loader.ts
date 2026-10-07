import { createRequire } from 'node:module'
import type { PostHog } from 'posthog-node'

// Structural subset of posthog-node so this loader never forces an eager import
// and satisfies the no-`import()`-type lint rule.
export type PostHogModule = {
  PostHog: new (
    apiKey: string,
    options: {
      host: string
      flushAt: number
      flushInterval: number
      disableGeoip: boolean
      maxQueueSize: number
    }
  ) => PostHog
}

// Kept in its own module (mirrors src/main/linear/linear-sdk.ts) so tests can
// mock the loader — a raw createRequire bypasses vitest's module registry.
const requireFromMain = createRequire(__filename)
let cached: PostHogModule | null = null

export function loadPostHogModule(): PostHogModule {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the posthog-node entrypoint shape is fixed by the package contract.
  cached ??= requireFromMain('posthog-node') as PostHogModule
  return cached
}
