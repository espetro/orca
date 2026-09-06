// Shared timeouts for the agent-browser bridge command pipeline.
export const EXEC_TIMEOUT_MS = 90_000
export const CONSECUTIVE_TIMEOUT_LIMIT = 3
export const WAIT_PROCESS_TIMEOUT_GRACE_MS = 1_000
export const STALE_SESSION_CLOSE_TIMEOUT_MS = 3_000
// Why separate from EXEC_TIMEOUT_MS: a close is a member of the 20s will-quit barrier and must finish well inside it.
export const AGENT_BROWSER_CLEANUP_TIMEOUT_MS = 5_000
export const AGENT_BROWSER_CLEANUP_CONCURRENCY = 4
export const EMBEDDED_NAVIGATION_TIMEOUT_MS = 30_000
