import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import {
  BRACKETED_PASTE_QUIET_MS,
  type RuntimeTerminalDataMeta,
  type RuntimePtyWorktreeRecord,
  type TerminalHandleRecord
} from './runtime-contracts'
import type { RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'

export function waitForStartupDraftReady(
  deps: {
    getLivePtyForHandle: (
      handle: string
    ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
    subscribeToTerminalData: (
      ptyId: string,
      listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
    ) => () => void
    recentPtyOutputById: Map<string, RecentPtyOutputBuffer>
  },
  handle: string,
  agent: TuiAgent
): Promise<string | null> {
  const livePty = deps.getLivePtyForHandle(handle)
  const ptyId = livePty?.pty.ptyId
  if (!ptyId) {
    return Promise.resolve(null)
  }
  const readySignal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  return new Promise<string | null>((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(readySignal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null

    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      unsubscribe?.()
      resolve(value)
    }

    const armQuietTimer = (): void => {
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      quietTimer = setTimeout(() => finish(ptyId), BRACKETED_PASTE_QUIET_MS)
    }

    const observeData = (data: string): void => {
      const { ready, armQuietTimer: shouldArm } = scanner.observe(data)
      if (ready) {
        finish(ptyId)
        return
      }
      if (shouldArm) {
        armQuietTimer()
      }
    }

    unsubscribe = deps.subscribeToTerminalData(ptyId, observeData)
    const replay = deps.recentPtyOutputById.get(ptyId)?.read()
    if (replay) {
      observeData(replay)
    }
    hardTimer = setTimeout(() => finish(null), resolveDraftPasteReadyTimeoutMs(agent))
  })
}
