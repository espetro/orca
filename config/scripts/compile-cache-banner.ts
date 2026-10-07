export function createCompileCacheBanner(): string {
  // Why here and not in main-process-preflight: module.enableCompileCache() is not
  // retroactive — by preflight time the entire static import graph of index.ts has
  // already been evaluated, so nothing of the main process's own startup would be
  // cached. Prepending to the bundle entry caches the real startup graph.
  // No-arg call uses Node's default cache dir (per-user, outside userData), so the
  // later dev/E2E userData redirect cannot misplace it; entries are keyed by chunk
  // content hash, which is identical across profiles.
  return `
;(() => {
  try {
    const nodeModule = require('node:module')
    if (typeof nodeModule.enableCompileCache === 'function') {
      const result = nodeModule.enableCompileCache()
      if (result && result.directory && typeof process !== 'undefined' && process.env) {
        // Why: child processes (daemon, plugin-host, sidecars) inherit env and reuse the cache.
        process.env.NODE_COMPILE_CACHE = result.directory
      }
    }
  } catch {
    // A cache-dir failure must never block startup.
  }
})();
`
}
