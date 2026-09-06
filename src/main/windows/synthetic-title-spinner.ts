import type { BrowserWindow } from 'electron'
import type { AgentStatusState } from '../../shared/agent-status-types'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  type SyntheticAgentTitleProfile
} from '../../shared/synthetic-agent-title'
import {
  advanceSyntheticTitleSpinnerEntries,
  type SyntheticTitleSpinnerEntry
} from '../synthetic-title-spinner'
import { shouldCopySyntheticTitleFrameToPtyData } from '../synthetic-title-frame-routing'
import { shouldSendSyntheticTitleFrame } from '../synthetic-title-visibility'
import { resolveTuiAgentPermissionMode } from '../../shared/tui-agent-permissions'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

// Why: cursor-agent re-emits its own OSC title on every redraw, overwriting a one-shot frame — so re-assert a working frame on an interval.
// 80ms matches Pi's cadence (smooth but under the IPC budget). opencode needs only one frame but reuses this for consistent animated UX.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

export type SyntheticTitleSpinnerDeps = {
  getWindow: () => BrowserWindow | null
  getRuntime: () => OrcaRuntimeService | null
  getStore: () => Store | null
  getPtyIdForPaneKey: (paneKey: string) => string | null | undefined
}

export function createSyntheticTitleSpinnerController(deps: SyntheticTitleSpinnerDeps) {
  const syntheticTitleSpinnerByPaneKey = new Map<
    string,
    SyntheticTitleSpinnerEntry<SyntheticAgentTitleProfile>
  >()
  let syntheticTitleSpinnerTimer: ReturnType<typeof setInterval> | null = null

  function sendSyntheticTitle(
    ptyId: string,
    data: string,
    options: { force?: boolean } = {}
  ): void {
    const window = deps.getWindow()
    if (!window || window.isDestroyed()) {
      return
    }
    // Why: throttle decorative spinner frames (up to 80ms/agent); final/permission frames are forced because they drive BEL.
    if (
      !shouldSendSyntheticTitleFrame({
        force: options.force === true,
        windowVisible: isSyntheticTitleWindowVisible()
      })
    ) {
      return
    }
    // Why: feed the per-PTY tracker directly, never onPtyData — emulator/tails/transcripts/stats must not see fabricated bytes.
    deps.getRuntime()?.ingestSyntheticTitleFrame(ptyId, data)
    // Why: only the kill-switch-off renderer byte-parses synthetic frames; under main authority the copy mints phantom ACKs (see synthetic-title-frame-routing.ts).
    if (shouldCopySyntheticTitleFrameToPtyData(deps.getStore()?.getSettings())) {
      window.webContents.send('pty:data', { id: ptyId, data })
    }
  }

  function isSyntheticTitleWindowVisible(): boolean {
    const window = deps.getWindow()
    return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  }

  function canSendDecorativeSyntheticTitle(): boolean {
    return shouldSendSyntheticTitleFrame({
      force: false,
      windowVisible: isSyntheticTitleWindowVisible()
    })
  }

  function stopSyntheticTitleSpinner(paneKey: string): void {
    if (syntheticTitleSpinnerByPaneKey.delete(paneKey)) {
      stopSyntheticTitleSpinnerTimerIfIdle()
    }
  }

  function stopAllSyntheticTitleSpinners(): void {
    syntheticTitleSpinnerByPaneKey.clear()
    stopSyntheticTitleSpinnerTimer()
  }

  function stopSyntheticTitleSpinnerTimer(): void {
    if (!syntheticTitleSpinnerTimer) {
      return
    }
    clearInterval(syntheticTitleSpinnerTimer)
    syntheticTitleSpinnerTimer = null
  }

  function stopSyntheticTitleSpinnerTimerIfIdle(): void {
    if (syntheticTitleSpinnerByPaneKey.size === 0) {
      stopSyntheticTitleSpinnerTimer()
    }
  }

  function tickSyntheticTitleSpinners(): void {
    if (!canSendDecorativeSyntheticTitle()) {
      stopSyntheticTitleSpinnerTimer()
      return
    }
    const ticks = advanceSyntheticTitleSpinnerEntries({
      entries: syntheticTitleSpinnerByPaneKey,
      frameCount: SPINNER_FRAMES.length,
      getPtyIdForPaneKey: deps.getPtyIdForPaneKey
    })
    for (const tick of ticks) {
      sendSyntheticTitle(
        tick.ptyId,
        `\x1b]0;${SPINNER_FRAMES[tick.frame]} ${tick.profile.workingLabel}\x07`
      )
    }
    stopSyntheticTitleSpinnerTimerIfIdle()
  }

  function ensureSyntheticTitleSpinnerTimer(): void {
    if (
      syntheticTitleSpinnerTimer ||
      syntheticTitleSpinnerByPaneKey.size === 0 ||
      !canSendDecorativeSyntheticTitle()
    ) {
      return
    }
    // Why: one shared timer for all spinners — per-pane intervals multiplied idle wakeups when several agents were working.
    syntheticTitleSpinnerTimer = setInterval(tickSyntheticTitleSpinners, SPINNER_INTERVAL_MS)
  }

  function resumeSyntheticTitleSpinnerTimer(): void {
    ensureSyntheticTitleSpinnerTimer()
  }

  function driveSyntheticTitleFromHook(
    paneKey: string,
    state: AgentStatusState,
    profile: SyntheticAgentTitleProfile
  ): void {
    const ptyId = deps.getPtyIdForPaneKey(paneKey)
    if (!ptyId) {
      return
    }
    if (state === 'working') {
      // Why: emit the first frame immediately so the spinner is visible now, not up to 80ms later at the next interval tick.
      const existing = syntheticTitleSpinnerByPaneKey.get(paneKey)
      const frame = existing ? existing.frame : 0
      sendSyntheticTitle(ptyId, `\x1b]0;${SPINNER_FRAMES[frame]} ${profile.workingLabel}\x07`)
      if (existing) {
        // Why: refresh the profile so a mid-pane agent-type change lands on the right idle/permission labels at terminal state.
        existing.profile = profile
        return
      }
      syntheticTitleSpinnerByPaneKey.set(paneKey, { frame, profile })
      ensureSyntheticTitleSpinnerTimer()
      return
    }
    // Why: stop the spinner first so the next tick can't race the state back to "working", then inject the terminal frame.
    // Permission frames add a trailing BEL to light up user-input states; done frames omit it (completion notifications own that attention).
    stopSyntheticTitleSpinner(paneKey)
    const needsUserInput = state === 'blocked' || state === 'waiting'
    const label = needsUserInput ? profile.permissionLabel : profile.idleLabel
    sendSyntheticTitle(ptyId, `\x1b]0;${label}\x07${needsUserInput ? '\x07' : ''}`, {
      force: true
    })
  }

  return {
    sendSyntheticTitle,
    canSendDecorativeSyntheticTitle,
    stopSyntheticTitleSpinner,
    stopAllSyntheticTitleSpinners,
    stopSyntheticTitleSpinnerTimer,
    resumeSyntheticTitleSpinnerTimer,
    driveSyntheticTitleFromHook
  }
}

export function shouldSuppressCodexAutoApprovalSyntheticTitleFromHook(args: {
  agentType: string | null | undefined
  state: AgentStatusState
  launchConfig:
    | {
        agentArgs?: string | null
        agentEnv?: Record<string, string> | null
      }
    | null
    | undefined
}): boolean {
  if (args.agentType !== 'codex' || (args.state !== 'waiting' && args.state !== 'blocked')) {
    return false
  }
  if (!args.launchConfig) {
    return false
  }
  return (
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: args.launchConfig.agentArgs,
      agentEnv: args.launchConfig.agentEnv
    }) === 'yolo'
  )
}

export {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  type SyntheticAgentTitleProfile
}
